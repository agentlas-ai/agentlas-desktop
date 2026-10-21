import type { InvocationRuntimeFailure } from "./types";
import { formatRuntimeQuotaReset } from "./runtime-quota";

/**
 * What the transcript says when a run ended without a reply, built from the run's typed failure only.
 * Pure, with no Electron, Node or renderer imports, so Main, the daemon and a re-vendored terminal
 * core write the same sentence.
 *
 * Before this, every run that ended without a reply left one generic line ("The run failed before it could finish a
 * reply …") whatever the cause. An antigravity turn blocked by the provider's content safety filters read exactly like a
 * crash, as an "app problem", while the real cause lived only in run events.
 *
 * The facts are the host's own typed ones (InvocationRuntimeFailure: kind, source, providerCode, and for an unfinished turn
 * the runner's `cause`; the terminal code; the delivery fact). The text never classifies prose. The failure's own message is
 * quoted after the app-language sentence (bounded, one line) where the cause is not the kind itself, so the provider's
 * reason stays visible: a runner that gave no machine code for a safety block (antigravityFailureKind keeps such an error
 * "refused" and says why only in words) is still told in the provider's words.
 *
 * Two shapes reach here:
 *  - a failure reported before anything was dispatched (HTTP 401/403/429 of an API, a local rejection): its own kind;
 *  - an unfinished turn: mcp/client.ts ends every dispatched turn that has no completed terminal as
 *    runtime_turn_unsettled, which every runner and runnerFailureFromError report as `refused`, so that kind proves nothing
 *    about a refusal. What the runner itself reported behind it rides along as `cause`; the text names that class and adds
 *    that tools may already have run (so it was not sent again). Without a usable cause it is worded as a turn that ended
 *    without a completion receipt, and the reported reason follows in the failure's own words.
 *
 *  - quota / rate_limit / auth: the typed kind says everything; no quote.
 *  - refused: only a provider-owned code (the closed list below) or no code is worded as the provider's refusal; any other
 *    code is a host-owned limit (context capacity, a busy MCP scope, a Windows argv budget …) with its own message and
 *    returns null for a direct failure (the caller keeps its previous sentence) or the neutral unfinished-turn wording.
 *
 * `source: "heuristic"` is worded as a likelihood, never a verdict.
 */

export type RunFailureNoticeLocale = "ko" | "en";
export type RunFailureNoticeCause = "quota" | "rate_limit" | "auth" | "refused" | "unsettled";

/** The terminal code of a dispatched turn that ended without a terminal receipt (runtime/runner.ts RUNTIME_TURN_UNSETTLED_CODE). */
export const RUN_FAILURE_UNSETTLED_CODE = "runtime_turn_unsettled";

/**
 * Machine codes with which a provider (or its API) reports a response it declined or blocked: the codex policy and
 * content-filter outcomes, an Anthropic/Grok `refusal` stop, a local content_filter finish, a Google safety finish
 * reason, a gateway 403. A closed list on purpose: a host-owned `refused` code must never be told as the provider's
 * refusal, so an unknown code is not in it.
 */
export const PROVIDER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "codex_content_filter", "codex_cyber_policy", "codex_misalignment_policy_violation", "codex_bio_policy",
  "refusal", "content_filter", "http_403",
  "SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED",
]);

const TYPED_KINDS: ReadonlySet<string> = new Set(["quota", "rate_limit", "auth", "refused"]);
const DETAIL_MAX = 220;

type TypedFailure = Pick<InvocationRuntimeFailure, "kind" | "source" | "providerCode" | "retryAfterAt">;

export interface RunFailureNoticeFacts {
  locale: RunFailureNoticeLocale;
  /** The run's terminal machine code (event.error.code, receipt.errorCode). */
  errorCode?: string | null;
  /** The host-observed provider failure (event.error.runtimeFailure, receipt.runtimeFailure). */
  runtimeFailure?: (TypedFailure & { cause?: TypedFailure }) | null;
  /** event.error.turnDelivery: "not-dispatched" is the one value that proves nothing reached the provider. */
  turnDelivery?: string | null;
  /** The failure's own message as the run reported it. Quoted, never read. */
  detail?: string | null;
}

/** A typed provider failure (quota, rate limit, sign-in, refusal): the owner may have something to do. */
export function isTypedProviderRunFailure(runtimeFailure: RunFailureNoticeFacts["runtimeFailure"] | undefined): boolean {
  return Boolean(runtimeFailure && TYPED_KINDS.has(runtimeFailure.kind));
}

/** The class a typed failure states: quota, rate_limit and auth as they are; `refused` only when the provider owns the code. */
function typedClass(failure: TypedFailure | null | undefined): Exclude<RunFailureNoticeCause, "unsettled"> | null {
  if (!failure || !TYPED_KINDS.has(failure.kind)) return null;
  if (failure.kind !== "refused") return failure.kind;
  if (failure.providerCode === undefined || failure.providerCode === "" || PROVIDER_REFUSAL_CODES.has(failure.providerCode)) return "refused";
  return null;
}

interface Resolved { cause: RunFailureNoticeCause; unfinished: boolean; failure: TypedFailure }

function resolve(facts: Pick<RunFailureNoticeFacts, "errorCode" | "runtimeFailure">): Resolved | null {
  const failure = facts.runtimeFailure;
  if (!failure || !TYPED_KINDS.has(failure.kind)) return null;
  const unfinished = failure.kind === "refused"
    && (failure.providerCode === RUN_FAILURE_UNSETTLED_CODE || (!failure.providerCode && facts.errorCode === RUN_FAILURE_UNSETTLED_CODE));
  if (unfinished) {
    const named = typedClass(failure.cause);
    return named ? { cause: named, unfinished: true, failure: failure.cause! } : { cause: "unsettled", unfinished: true, failure };
  }
  const named = typedClass(failure);
  return named ? { cause: named, unfinished: false, failure } : null;
}

/** The cause the notice states, or null when no typed provider cause is known (the caller keeps its previous sentence). */
export function runFailureNoticeCause(facts: Pick<RunFailureNoticeFacts, "errorCode" | "runtimeFailure">): RunFailureNoticeCause | null {
  return resolve(facts)?.cause ?? null;
}

interface Copy { lead: [string, string]; action: string }

const KO: Record<RunFailureNoticeCause, Copy> = {
  quota: { lead: ["이 모델의 사용 한도(요금제·잔액)가 소진되어 답변을 완료하지 못했습니다.", "이 모델의 사용 한도(요금제·잔액)가 소진되어 답변을 완료하지 못한 것으로 보입니다."],
    action: "한도가 풀린 뒤 같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  rate_limit: { lead: ["공급자의 요청 속도 제한에 걸려 답변을 완료하지 못했습니다.", "공급자의 요청 속도 제한에 걸려 답변을 완료하지 못한 것으로 보입니다."],
    action: "잠시 뒤 같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  auth: { lead: ["공급자 로그인·인증이 필요하거나 만료되어 답변을 완료하지 못했습니다.", "공급자 로그인·인증이 필요하거나 만료되어 답변을 완료하지 못한 것으로 보입니다."],
    action: "설정에서 해당 모델을 다시 연결한 뒤 같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  refused: { lead: ["모델 공급자가 이 요청의 응답을 거절했습니다(안전·정책 필터가 응답을 막은 경우를 포함합니다).", "모델 공급자가 이 요청의 응답을 거절한 것으로 보입니다(안전·정책 필터가 응답을 막은 경우를 포함합니다)."],
    action: "같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  unsettled: { lead: ["응답이 완료 확인 없이 끝나 답변을 완료하지 못했습니다.", "응답이 완료 확인 없이 끝나 답변을 완료하지 못한 것으로 보입니다."],
    action: "같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
};

const EN: Record<RunFailureNoticeCause, Copy> = {
  quota: { lead: ["This model's usage limit (plan or balance) is used up, so the reply could not be completed.", "This model's usage limit (plan or balance) appears to be used up, so the reply could not be completed."],
    action: "Send it again once the limit lifts, or choose another model." },
  rate_limit: { lead: ["The provider rate-limited the request, so the reply could not be completed.", "The provider appears to have rate-limited the request, so the reply could not be completed."],
    action: "Send it again in a moment, or choose another model." },
  auth: { lead: ["The provider needs you to sign in (or the sign-in expired), so the reply could not be completed.", "The provider appears to need you to sign in (or the sign-in expired), so the reply could not be completed."],
    action: "Reconnect that model in Settings and send it again, or choose another model." },
  refused: { lead: ["The model provider refused to answer this request (this includes its safety or policy filter blocking the response).", "The model provider appears to have refused to answer this request (this includes its safety or policy filter blocking the response)."],
    action: "Send it again, or choose another model." },
  unsettled: { lead: ["The reply ended without a completion receipt, so it could not be completed.", "The reply appears to have ended without a completion receipt, so it could not be completed."],
    action: "Send it again, or choose another model." },
};

const SAVED = { ko: "요청은 저장되어 있습니다.", en: "Your request is saved." } as const;
const NOT_SENT = { ko: "모델 공급자에는 아무것도 보내지 않았습니다.", en: "Nothing was sent to the model provider." } as const;
const MAY_HAVE_ACTED = { ko: "요청이 이미 실행됐을 수 있어 자동으로 다시 보내지 않았습니다.", en: "The request may already have acted, so it was not sent again automatically." } as const;
const CHECK_HISTORY = { ko: "실행 기록에서 어디까지 실행됐는지 확인하세요.", en: "Check the run history for what already ran." } as const;
const DETAIL_LABEL = { ko: "보고된 사유", en: "Reported reason" } as const;

/** One bounded line of the failure's own words: control characters, markup quotes and line breaks out, never reworded. */
export function boundedFailureDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/[`“”"]+/g, "'").replace(/\s+/g, " ").trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > DETAIL_MAX ? `${chars.slice(0, DETAIL_MAX - 1).join("").trimEnd()}…` : line;
}

/** The notice text for a run that ended without a reply, or null when no typed provider cause is known. */
export function runFailureNoticeText(facts: RunFailureNoticeFacts): string | null {
  const resolved = resolve(facts);
  if (!resolved) return null;
  const locale = facts.locale === "ko" ? "ko" : "en";
  const copy = (locale === "ko" ? KO : EN)[resolved.cause];
  const hedged = resolved.failure.source === "heuristic";
  const detail = resolved.cause === "refused" || resolved.cause === "unsettled" ? boundedFailureDetail(facts.detail) : null;
  const reset = resolved.cause === "quota" ? formatRuntimeQuotaReset(resolved.failure.retryAfterAt, locale) : null;
  return [
    copy.lead[hedged ? 1 : 0],
    facts.turnDelivery === "not-dispatched" ? NOT_SENT[locale] : resolved.unfinished ? MAY_HAVE_ACTED[locale] : undefined,
    reset,
    SAVED[locale],
    resolved.unfinished ? CHECK_HISTORY[locale] : undefined,
    copy.action,
    detail ? `${DETAIL_LABEL[locale]}: “${detail}”` : undefined,
  ].filter(Boolean).join(" ");
}
