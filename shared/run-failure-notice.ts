import type { InvocationRuntimeFailure } from "./types";
import { formatRuntimeQuotaReset } from "./runtime-quota";
import { EMPTY_AFTER_UNUSABLE_TOOLS_CODE, EMPTY_NO_TOOL_RAN_CODES } from "./turn-settlement";

/**
 * What the transcript says when a run ended without a reply, built from the run's typed failure only (F51, Finance 1008
 * validation 2026-10-21). Pure, with no Electron, Node or renderer imports, so Main, the daemon and a re-vendored terminal
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
 *  - quota / rate_limit / auth: the typed kind says everything; no quote. One exception: a quota with no machine reset time
 *    (retryAfterAt) quotes the reported reason, because that sentence may be the only place the reset time is written.
 *  - refused: only a provider-owned code (the closed list below) or no code is worded as the provider's refusal; any other
 *    code is a host-owned limit (context capacity, a busy MCP scope, a Windows argv budget …) with its own message and
 *    returns null for a direct failure (the caller keeps its previous sentence) or the neutral unfinished-turn wording.
 *
 *  - empty: only as the `cause` behind an unfinished turn (a turn that ended with no text and no tool call; every runner types
 *    it). Named as the model's empty answer; the runner's own words are quoted only when it gave no code of its own.
 *  - empty_no_tool: an `empty` cause whose host-owned code (EMPTY_NO_TOOL_RAN_CODES) says a host loop ended the turn with no
 *    text before dispatching any tool: nothing ran, so the notice says so instead of "may already have acted" (2026-10-28).
 *  - tools_unusable: an `empty` cause whose host-owned code (EMPTY_CAUSE_CODE_CLASSES) says the turn ended with no reply text
 *    after tool calls that all failed or came back empty (H2, 2026-10-21). The code is the whole reason; nothing is quoted.
 *  - capacity / unavailable: a host-owned machine code that names its class (HOST_FAILURE_CODE_CLASSES), read from the
 *    failure's code or, when the event carries no typed failure (the serving 503 is kind `exit`), from the terminal code.
 *    The code is the whole reason, so nothing is quoted. Any other host-owned code still returns null.
 *
 * `source: "heuristic"` is worded as a likelihood, never a verdict.
 */

export type RunFailureNoticeLocale = "ko" | "en";
export type RunFailureNoticeCause = "quota" | "rate_limit" | "auth" | "refused" | "empty" | "empty_no_tool" | "tools_unusable" | "unavailable" | "capacity" | "subscription_credits_off" | "tool_missing" | "tool_failed" | "tools_unprepared" | "runtime_unavailable" | "runtime_changed" | "goal_changed" | "store_busy" | "mobile_boundary" | "project_busy" | "provider_connection" | "unsettled";

/** The terminal code of a dispatched turn that ended without a terminal receipt (runtime/runner.ts RUNTIME_TURN_UNSETTLED_CODE). */
export const RUN_FAILURE_UNSETTLED_CODE = "runtime_turn_unsettled";

/**
 * Machine codes with which a provider (or its API) reports a response it declined or blocked: the codex policy and
 * content-filter outcomes, an Anthropic/Grok `refusal` stop, a local content_filter finish, a Google safety finish
 * reason, a gateway 403, Antigravity's own stop reason CONTENT_FILTER (read from the conversation store it persists,
 * electron/runtime/antigravity-conversation-metadata.ts: no stream surface of agy names it). A closed list on purpose: a
 * host-owned `refused` code must never be told as the provider's refusal, so an unknown code is not in it.
 */
export const PROVIDER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "codex_content_filter", "codex_cyber_policy", "codex_misalignment_policy_violation", "codex_bio_policy",
  "refusal", "content_filter", "http_403",
  "SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED",
  "STOP_REASON_CONTENT_FILTER",
]);

type HostFailureClass = "capacity" | "unavailable" | "subscription_credits_off" | "tool_missing" | "tool_failed" | "tools_unprepared" | "runtime_unavailable" | "runtime_changed" | "goal_changed" | "store_busy" | "mobile_boundary" | "project_busy" | "provider_connection";

/**
 * Host-owned machine codes that name a class of their own, with the sentence that class gets (F51 follow-up, Finance 1008
 * validation 2026-10-21). A closed table of codes, never of words: `capacity` is the input that does not fit the model's
 * context window (the local pre-send check of BYOK / local models / Agentlas serving, the serving endpoint's 413, codex's
 * contextWindowExceeded: all `refused` with a host-owned code), `unavailable` is the Agentlas serving endpoint's own 503
 * (its failure carries kind `exit`, which the event does not carry, so the terminal code is the fact).
 */
export const HOST_FAILURE_CODE_CLASSES: ReadonlyMap<string, HostFailureClass> = new Map<string, HostFailureClass>([
  ["model_context_capacity_exceeded", "capacity"], ["codex_context_window_exceeded", "capacity"],
  ["serving_unavailable", "unavailable"],
  // The host refused the run before dispatch: the subscription limit is reached and the owner's automatic credit use is off
  // (runtime/selection.ts withRuntimeAuthProbe, claude-code and codex). Finance validation 2026-10-28: a codex run refused
  // for exactly this read "The run failed …" with no reason while the banner said the limit was only near.
  ["subscription_credits_disabled", "subscription_credits_off"],
  // Host-owned codes a run already ended with, each with a host-written reason that the transcript line used to replace with
  // "The run failed …" (audit 2026-10-28, production ledger + client.ts/service.ts throw sites; the table in docs
  // 2026-10-28-common-defects-goal-stop). App-side codes (shared/run-failure-cause.ts) are deliberately not here.
  ["image_tool_unavailable", "tool_missing"], ["image_generation_failed", "tool_failed"],
  ["mcp-runtime-config-unavailable", "tools_unprepared"], ["mcp-goal-tool-scope-changed", "tools_unprepared"],
  ["one-runtime-unavailable", "runtime_unavailable"], ["no-runtime", "runtime_unavailable"],
  ["one-team-runtime-selection-changed", "runtime_changed"], ["automatic-goal-resume-state-changed", "goal_changed"],
  ["store_busy", "store_busy"], ["mobile-runtime-not-read-sandboxed", "mobile_boundary"],
  ["work_project_residency_busy", "project_busy"], ["codex_http_connection_failed", "provider_connection"],
]);

/**
 * Host-owned machine codes of an `empty` cause that name a narrower class than the model's empty answer: the chat turn that
 * ended with no reply text after every tool call it made failed or came back empty (mcp/client.ts, shared/turn-settlement.ts
 * endedWithoutAnswerAfterUnusableTools). A closed table of codes, never of words.
 */
export const EMPTY_CAUSE_CODE_CLASSES: ReadonlyMap<string, "tools_unusable" | "empty_no_tool"> = new Map<string, "tools_unusable" | "empty_no_tool">([
  [EMPTY_AFTER_UNUSABLE_TOOLS_CODE, "tools_unusable"],
  ...[...EMPTY_NO_TOOL_RAN_CODES].map((code) => [code, "empty_no_tool"] as const),
]);

const TYPED_KINDS: ReadonlySet<string> = new Set(["quota", "rate_limit", "auth", "refused"]);
const DETAIL_MAX = 220;

type TypedFailure = Pick<InvocationRuntimeFailure, "kind" | "source" | "providerCode" | "retryAfterAt">;
type NamedClass = Exclude<RunFailureNoticeCause, "unsettled">;

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
function typedClass(failure: TypedFailure | null | undefined): Extract<NamedClass, "quota" | "rate_limit" | "auth" | "refused"> | null {
  if (!failure || !TYPED_KINDS.has(failure.kind) || failure.kind === "empty") return null;
  if (failure.kind !== "refused") return failure.kind;
  if (failure.providerCode === undefined || failure.providerCode === "" || PROVIDER_REFUSAL_CODES.has(failure.providerCode)) return "refused";
  return null;
}

/** The class of a host-owned code: the closed table above. */
function hostClassOfCode(code: unknown): HostFailureClass | null {
  return typeof code === "string" ? HOST_FAILURE_CODE_CLASSES.get(code) ?? null : null;
}

/**
 * The class a failure inside an unfinished turn (the runner's `cause`) names, beyond the four provider verdicts: a turn that
 * ended with no text and no tool call is `empty` (every runner types it so), and a host-owned code names its own class.
 */
function causeClass(failure: TypedFailure | null | undefined): NamedClass | null {
  if (!failure) return null;
  const verdict = typedClass(failure);
  if (verdict) return verdict;
  if (failure.kind === "empty") return (typeof failure.providerCode === "string" ? EMPTY_CAUSE_CODE_CLASSES.get(failure.providerCode) : undefined) ?? "empty";
  return failure.kind === "refused" ? hostClassOfCode(failure.providerCode) : null;
}

interface Resolved { cause: RunFailureNoticeCause; unfinished: boolean; failure: Pick<TypedFailure, "source" | "retryAfterAt" | "providerCode"> }

function resolve(facts: Pick<RunFailureNoticeFacts, "errorCode" | "runtimeFailure">): Resolved | null {
  const failure = facts.runtimeFailure;
  if (failure && TYPED_KINDS.has(failure.kind)) {
    const unfinished = failure.kind === "refused"
      && (failure.providerCode === RUN_FAILURE_UNSETTLED_CODE || (!failure.providerCode && facts.errorCode === RUN_FAILURE_UNSETTLED_CODE));
    if (unfinished) {
      const named = causeClass(failure.cause);
      return named ? { cause: named, unfinished: true, failure: failure.cause! } : { cause: "unsettled", unfinished: true, failure };
    }
    const named = causeClass(failure);
    return named ? { cause: named, unfinished: false, failure } : null;
  }
  // No typed provider failure (a failure of kind `exit` is not carried by the event): the run's own terminal machine code,
  // when it is one of the host-owned codes that name a class. An unfinished turn never gets here (it needs its failure).
  const named = hostClassOfCode(facts.errorCode);
  return named ? { cause: named, unfinished: false, failure: { source: "marker" } } : null;
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
  empty: { lead: ["모델이 빈 답을 돌려줘 답변을 완료하지 못했습니다.", "모델이 빈 답을 돌려줘 답변을 완료하지 못한 것으로 보입니다."],
    action: "같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  empty_no_tool: { lead: ["모델이 답도 도구 호출도 없이 턴을 끝내 답변을 완료하지 못했습니다.", "모델이 답도 도구 호출도 없이 턴을 끝내 답변을 완료하지 못한 것으로 보입니다."],
    action: "같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  tools_unusable: { lead: ["모델이 호출한 도구가 모두 실패했거나 빈 결과를 돌려줬고, 모델이 답을 쓰지 않고 끝나 답변을 완료하지 못했습니다.", "모델이 호출한 도구가 모두 실패했거나 빈 결과를 돌려줬고, 모델이 답을 쓰지 않고 끝나 답변을 완료하지 못한 것으로 보입니다."],
    action: "같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  unavailable: { lead: ["Agentlas 모델 서비스를 지금 사용할 수 없어 답변을 완료하지 못했습니다.", "Agentlas 모델 서비스를 지금 사용할 수 없어 답변을 완료하지 못한 것으로 보입니다."],
    action: "잠시 뒤 같은 요청을 다시 보내거나 다른 모델을 선택해 보세요." },
  capacity: { lead: ["요청이 모델의 입력(컨텍스트) 한도를 넘어 답변을 완료하지 못했습니다.", "요청이 모델의 입력(컨텍스트) 한도를 넘어 답변을 완료하지 못한 것으로 보입니다."],
    action: "새 대화를 시작하거나 요청·첨부를 줄여 다시 보내 보세요." },
  subscription_credits_off: { lead: ["구독 사용 한도에 도달했고 크레딧 자동 사용이 꺼져 있어 이 실행을 시작하지 않았습니다.", "구독 사용 한도에 도달했고 크레딧 자동 사용이 꺼져 있어 이 실행을 시작하지 않은 것으로 보입니다."],
    action: "한도가 다시 열린 뒤 보내거나, 대시보드 사용량에서 크레딧 사용을 켜거나, 다른 모델을 선택해 보세요." },
  tool_missing: { lead: ["이 요청에 필요한 도구(이미지 생성)가 이 앱에 연결돼 있지 않아 완료하지 못했습니다.", "이 요청에 필요한 도구(이미지 생성)가 이 앱에 연결돼 있지 않아 완료하지 못한 것으로 보입니다."],
    action: "설정에서 이미지 모델을 연결한 뒤 다시 보내거나, 이미지 없이 할 수 있는 방식으로 요청해 보세요." },
  tool_failed: { lead: ["이미지 생성 도구가 결과를 만들지 못해 완료하지 못했습니다.", "이미지 생성 도구가 결과를 만들지 못해 완료하지 못한 것으로 보입니다."],
    action: "같은 요청을 다시 보내거나 설정에서 다른 이미지 모델을 골라 보세요." },
  tools_unprepared: { lead: ["이 실행에 쓸 도구 연결을 준비하지 못해 시작하지 않았습니다.", "이 실행에 쓸 도구 연결을 준비하지 못해 시작하지 않은 것으로 보입니다."],
    action: "도구(MCP) 연결 상태를 확인한 뒤 다시 보내 보세요." },
  runtime_unavailable: { lead: ["선택한 모델(실행기)을 지금 쓸 수 없어 시작하지 않았습니다.", "선택한 모델(실행기)을 지금 쓸 수 없어 시작하지 않은 것으로 보입니다."],
    action: "설정에서 모델 연결을 확인하거나 다른 모델을 골라 다시 보내 보세요." },
  runtime_changed: { lead: ["확인한 모델과 실제 실행 모델이 달라 실행하지 않았습니다.", "확인한 모델과 실제 실행 모델이 달라 실행하지 않은 것으로 보입니다."],
    action: "모델 선택을 다시 확인한 뒤 같은 요청을 보내 보세요." },
  goal_changed: { lead: ["목표 상태가 방금 바뀌어 이 메시지로 목표를 이어가지 않았습니다.", "목표 상태가 방금 바뀌어 이 메시지로 목표를 이어가지 않은 것으로 보입니다."],
    action: "목표 칩에서 상태를 확인한 뒤 다시 보내 보세요." },
  store_busy: { lead: ["Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못했습니다.", "Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못한 것으로 보입니다."],
    action: "실행 기록을 확인한 뒤 같은 요청을 다시 보내 보세요." },
  mobile_boundary: { lead: ["이 모델은 폰에서 쓰는 읽기 전용 경계가 검증되지 않아 실행하지 않았습니다.", "이 모델은 폰에서 쓰는 읽기 전용 경계가 검증되지 않아 실행하지 않은 것으로 보입니다."],
    action: "데스크탑에서 BYOK 또는 Ollama 모델을 골라 다시 보내 보세요." },
  project_busy: { lead: ["이 Work 프로젝트의 다른 채팅에서 에이전트가 아직 실행 중이라 시작하지 않았습니다.", "이 Work 프로젝트의 다른 채팅에서 에이전트가 아직 실행 중이라 시작하지 않은 것으로 보입니다."],
    action: "지금 실행이 끝난 뒤 다시 보내 주세요." },
  provider_connection: { lead: ["모델 공급자에 연결하지 못해(인증·네트워크) 답변을 완료하지 못했습니다.", "모델 공급자에 연결하지 못해(인증·네트워크) 답변을 완료하지 못한 것으로 보입니다."],
    action: "설정에서 해당 모델의 로그인을 확인한 뒤 다시 보내거나 다른 모델을 골라 보세요." },
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
  empty: { lead: ["The model returned an empty answer, so the reply could not be completed.", "The model appears to have returned an empty answer, so the reply could not be completed."],
    action: "Send it again, or choose another model." },
  empty_no_tool: { lead: ["The model ended the turn with no answer and no tool call, so the reply could not be completed.", "The model appears to have ended the turn with no answer and no tool call, so the reply could not be completed."],
    action: "Send it again, or choose another model." },
  tools_unusable: { lead: ["Every tool call the model made failed or came back empty, and it ended without writing a reply, so the reply could not be completed.", "Every tool call the model made appears to have failed or come back empty, and it ended without writing a reply, so the reply could not be completed."],
    action: "Send it again, or choose another model." },
  unavailable: { lead: ["The Agentlas model service is unavailable right now, so the reply could not be completed.", "The Agentlas model service appears to be unavailable right now, so the reply could not be completed."],
    action: "Send it again in a moment, or choose another model." },
  capacity: { lead: ["The request is larger than the model's input (context) limit, so the reply could not be completed.", "The request appears to be larger than the model's input (context) limit, so the reply could not be completed."],
    action: "Start a new conversation, or shorten the request or attachments, and send it again." },
  subscription_credits_off: { lead: ["The subscription usage limit is reached and automatic credit use is off, so this run was not started.", "The subscription usage limit appears to be reached with automatic credit use off, so this run was not started."],
    action: "Send it again once the limit resets, turn on credit use under Usage in the dashboard, or choose another model." },
  tool_missing: { lead: ["A tool this request needs (image generation) is not connected in this app, so it could not be completed.", "A tool this request needs (image generation) appears not to be connected in this app, so it could not be completed."],
    action: "Connect an image model in Settings and send it again, or ask for a way that needs no image." },
  tool_failed: { lead: ["The image generation tool produced no result, so it could not be completed.", "The image generation tool appears to have produced no result, so it could not be completed."],
    action: "Send it again, or choose another image model in Settings." },
  tools_unprepared: { lead: ["This run's tool connections could not be prepared, so it was not started.", "This run's tool connections appear not to have been prepared, so it was not started."],
    action: "Check the tool (MCP) connections and send it again." },
  runtime_unavailable: { lead: ["The selected model (runtime) is not available right now, so it was not started.", "The selected model (runtime) appears not to be available right now, so it was not started."],
    action: "Check the model connection in Settings, or choose another model and send it again." },
  runtime_changed: { lead: ["The model that would run differs from the one you confirmed, so it was not run.", "The model that would run appears to differ from the one you confirmed, so it was not run."],
    action: "Confirm the model choice again and send the same request." },
  goal_changed: { lead: ["The Goal just changed state, so this message did not continue it.", "The Goal appears to have just changed state, so this message did not continue it."],
    action: "Check the goal chip and send it again." },
  store_busy: { lead: ["The Agentlas store was locked by another write, so this turn could not be fully recorded.", "The Agentlas store appears to have been locked by another write, so this turn could not be fully recorded."],
    action: "Check the run history, then send the same request again." },
  mobile_boundary: { lead: ["This model's read-only boundary for the phone is not verified, so it was not run.", "This model's read-only boundary for the phone appears not to be verified, so it was not run."],
    action: "On the desktop, choose a BYOK or Ollama model and send it again." },
  project_busy: { lead: ["An agent is still running in another chat of this Work project, so this was not started.", "An agent appears to be still running in another chat of this Work project, so this was not started."],
    action: "Send it again once that run has finished." },
  provider_connection: { lead: ["The model provider could not be reached (sign-in or network), so the reply could not be completed.", "The model provider appears not to have been reached (sign-in or network), so the reply could not be completed."],
    action: "Check that model's sign-in in Settings and send it again, or choose another model." },
  unsettled: { lead: ["The reply ended without a completion receipt, so it could not be completed.", "The reply appears to have ended without a completion receipt, so it could not be completed."],
    action: "Send it again, or choose another model." },
};

const SAVED = { ko: "요청은 저장되어 있습니다.", en: "Your request is saved." } as const;
const NOT_SENT = { ko: "모델 공급자에는 아무것도 보내지 않았습니다.", en: "Nothing was sent to the model provider." } as const;
const MAY_HAVE_ACTED = { ko: "요청이 이미 실행됐을 수 있어 자동으로 다시 보내지 않았습니다.", en: "The request may already have acted, so it was not sent again automatically." } as const;
const NOTHING_RAN = { ko: "실행된 도구가 없어 아무것도 바뀌지 않았고, 자동으로 다시 보내지는 않았습니다.", en: "No tool ran, so nothing was changed; it was not sent again automatically." } as const;
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
  const reset = resolved.cause === "quota" ? formatRuntimeQuotaReset(resolved.failure.retryAfterAt, locale) : null;
  // A quota whose runner gave no machine reset time (Antigravity names it only inside its sentence: "Resets in 152h45m22s")
  // quotes the reported reason instead, so the owner still sees when it lifts. The words are quoted, never read (F55).
  // An empty answer quotes only when the runner reported it in its own words (no host-owned code): Cursor's or Codex's stderr
  // tail says why it was empty, while Agentlas serving's own code already is the whole reason.
  const quoted = resolved.cause === "refused" || resolved.cause === "unsettled" || (resolved.cause === "quota" && reset === null)
    || (resolved.cause === "empty" && !resolved.failure.providerCode);
  const detail = quoted ? boundedFailureDetail(facts.detail) : null;
  return [
    copy.lead[hedged ? 1 : 0],
    facts.turnDelivery === "not-dispatched" ? NOT_SENT[locale]
      : resolved.cause === "empty_no_tool" ? NOTHING_RAN[locale] : resolved.unfinished ? MAY_HAVE_ACTED[locale] : undefined,
    reset,
    SAVED[locale],
    resolved.unfinished && resolved.cause !== "empty_no_tool" ? CHECK_HISTORY[locale] : undefined,
    copy.action,
    detail ? `${DETAIL_LABEL[locale]}: “${detail}”` : undefined,
  ].filter(Boolean).join(" ");
}
