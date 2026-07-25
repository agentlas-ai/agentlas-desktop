// Judged One Decision risk + option disposition. The RISK_PATTERNS / REJECT / APPROVE
// wordlists in shared/one-decision are demoted to hints and labeled fallback; the
// resident judge decides by meaning, so a wire-the-money card phrased in a language
// the wordlists never covered still reaches R3/R4, and "send without CC" is not read
// as a rejection.
//
// normalizeOneDecision runs in synchronous code (mobile projection, authority
// validation, a renderer render pass), so the async electron paths that precede it
// warm the judgment cache here and the sync sites peek via oneDecisionJudgedReaders.
// A cache miss keeps today's deterministic verdict — the labeled fallback. The
// closed-form fields (SAFE_ID_RE, COST_RE, DEADLINE_RE) stay deterministic.

import {
  lexicalOneDecisionDisposition,
  lexicalOneDecisionRiskLevel,
  ONE_DECISION_DISPOSITION_JUDGMENT_KIND,
  ONE_DECISION_RISK_JUDGMENT_KIND,
  oneDecisionJudgmentTexts,
  type OneDecisionJudgedReaders,
  type OneDecisionOptionDisposition,
  type OneDecisionRiskLevel,
} from "../../shared/one-decision";
import type { PendingConfirmation } from "../../shared/types";
import { judge, peekJudgment } from "../system-agents/judgment";

const RISK_LABELS = ["R0", "R1", "R2", "R3", "R4"] as const;
const DISPOSITION_LABELS = ["choice", "approve", "reject", "modify"] as const;

const RISK_QUESTION =
  "How risky is the action this assistant decision request asks the user to authorize? " +
  "R0 read-only; R1 preparation/draft only; R2 limited reversible change (save, upload, install); " +
  "R3 external effect (send, publish, book, pay, delete); R4 critical/irreversible effect " +
  "(legal filing, wiring money, security/permission change, mass destruction of data).";

const RISK_GUIDANCE =
  "Under-warning is the dangerous direction: when the action genuinely sends, pays, publishes, or " +
  "destroys, say R3/R4 even if it is phrased in a language or slang no wordlist covers. Negated or " +
  "hypothetical phrasing ('nothing will be sent', 'preview only') lowers the level.";

const DISPOSITION_QUESTION =
  "For this ONE decision option, does choosing it approve/execute the proposed action (approve), " +
  "refuse it (reject), ask to modify or narrow it first (modify), or merely pick among neutral " +
  "alternatives (choice)?";

const DISPOSITION_GUIDANCE =
  "\"without X\" / '…없이 계속' are usually qualifiers on an action option, not refusals — " +
  "'Send without CC' approves sending. Only a phrase that negates the action itself " +
  "(do not send / 발송하지 않음) is a rejection.";

const RISK_HINTS = [
  { label: "R4" as const, words: ["transfer funds", "wire", "legal filing", "wipe all", "drop the database", "권한 변경", "송금", "전체 삭제"] },
  { label: "R3" as const, words: ["send", "publish", "post", "book", "pay", "purchase", "delete", "메일 발송", "게시", "예약", "결제", "삭제"] },
  { label: "R2" as const, words: ["save", "upload", "install", "connect", "rename", "저장", "업로드", "설치", "연결"] },
  { label: "R1" as const, words: ["draft", "prepare", "preview", "proposal", "초안", "준비", "미리보기"] },
  { label: "R0" as const, words: ["read", "view", "search", "review", "summarize", "조회", "검색", "요약"] },
];

const DISPOSITION_HINTS = [
  { label: "reject" as const, words: ["reject", "cancel", "do not", "skip", "not now", "거절", "취소", "중단", "하지 않"] },
  { label: "modify" as const, words: ["modify", "edit", "adjust", "review scope", "수정", "변경", "범위 검토"] },
  { label: "approve" as const, words: ["approve", "confirm", "proceed", "send", "publish", "pay", "허용", "승인", "진행", "발송", "결제"] },
];

/** Synchronous read of an already-judged risk level. null = keep the labeled fallback. */
export function judgedOneDecisionRisk(combinedText: string): OneDecisionRiskLevel | null {
  const verdict = peekJudgment<OneDecisionRiskLevel>(ONE_DECISION_RISK_JUDGMENT_KIND, combinedText);
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}

/** Synchronous read of an already-judged option disposition. */
export function judgedOneDecisionDisposition(optionText: string): OneDecisionOptionDisposition | null {
  const verdict = peekJudgment<OneDecisionOptionDisposition>(ONE_DECISION_DISPOSITION_JUDGMENT_KIND, optionText);
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}

/** Readers Main-side normalizeOneDecision callers pass; renderer render passes never do. */
export const oneDecisionJudgedReaders: OneDecisionJudgedReaders = {
  risk: judgedOneDecisionRisk,
  disposition: judgedOneDecisionDisposition,
};

// Only successful llm verdicts enter the judgment cache, so a failing warm (model
// down, timeout) would otherwise re-run on EVERY mobile snapshot. Remember inputs
// already attempted this session; the sync sites simply keep the labeled fallback.
const attemptedWarm = new Set<string>();
const ATTEMPTED_MAX = 500;

function markAttempted(key: string): void {
  attemptedWarm.add(key);
  if (attemptedWarm.size > ATTEMPTED_MAX) {
    const oldest = attemptedWarm.values().next().value;
    if (oldest !== undefined) attemptedWarm.delete(oldest);
  }
}

/**
 * Warm both decision judgments for one pending confirmation. Best-effort: any
 * failure leaves the synchronous sites on the deterministic labeled fallback.
 */
export async function prejudgeOneDecision(
  confirmation: Pick<PendingConfirmation, "question" | "header" | "options">,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const texts = oneDecisionJudgmentTexts(confirmation);
  if (attemptedWarm.has(texts.combined)) return;
  markAttempted(texts.combined);
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const lexicalDispositions = texts.options.map(lexicalOneDecisionDisposition);
  try {
    await judge<OneDecisionRiskLevel>({
      kind: ONE_DECISION_RISK_JUDGMENT_KIND,
      question: RISK_QUESTION,
      labels: RISK_LABELS,
      input: texts.combined,
      guidance: RISK_GUIDANCE,
      hints: RISK_HINTS,
      fallback: lexicalOneDecisionRiskLevel(texts.combined, lexicalDispositions),
      signal: opts.signal,
      timeoutMs,
    });
    for (const optionText of texts.options) {
      await judge<OneDecisionOptionDisposition>({
        kind: ONE_DECISION_DISPOSITION_JUDGMENT_KIND,
        question: DISPOSITION_QUESTION,
        labels: DISPOSITION_LABELS,
        input: optionText,
        guidance: DISPOSITION_GUIDANCE,
        hints: DISPOSITION_HINTS,
        fallback: lexicalOneDecisionDisposition(optionText),
        signal: opts.signal,
        timeoutMs,
      });
    }
  } catch {
    // Warm-only path; sync peeks simply miss and keep the fallback.
  }
}

/** Warm every listed pending decision (mobile snapshot pre-pass). */
export async function prejudgeOneDecisions(
  confirmations: readonly Pick<PendingConfirmation, "question" | "header" | "options">[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  for (const confirmation of confirmations) {
    await prejudgeOneDecision(confirmation, opts);
  }
}
