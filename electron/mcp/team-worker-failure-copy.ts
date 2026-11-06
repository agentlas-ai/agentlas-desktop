/*
 * What the owner reads when one worker of a team could not finish (a room teammate, a nested team's worker, a firm node).
 *
 * Before this, the transcript carried the failure's own exception message: "(Research Worker failed:
 * worker-capability-selection-unavailable)" for a firm node and "[vibecoder error] worker-capability-selection-unavailable"
 * plus the whole execution-failure JSON for a task-force teammate. The owner cannot act on a machine code.
 *
 * The sentence is derived from TYPED facts only, never from prose: the machine code the failure carries (its own `code`, then its
 * `cause` chain; a message that is itself a machine code counts, nothing else is read) looked up in a closed table, or the typed
 * provider failure (shared/run-failure-notice.ts runFailureNoticeCause, the same closed classes the run-level notice uses). A
 * failure with neither gets one neutral sentence. The code itself stays in the run ledger (execution_failure events) and in the
 * typed JSON the synthesizer reads; it is never put in front of the owner.
 *
 * Pure: no Electron, no store. Main, the daemon and a re-vendored copy word the same sentence.
 */
import { formatRuntimeQuotaReset } from "../../shared/runtime-quota";
import { HOST_FAILURE_CODE_CLASSES, boundedFailureDetail, runFailureNoticeCause, type RunFailureNoticeCause } from "../../shared/run-failure-notice";

export type TeamWorkerFailureLocale = "ko" | "en";

type HostClass = "tools_not_ready" | "settings_changed" | "goal_changed" | "stopped" | "access_not_granted" | "browser_unavailable" | "room_model_unavailable";

/** Host-owned machine codes a team worker can fail with, and the class each one names. A closed table of codes, never of words. */
export const TEAM_WORKER_HOST_FAILURE_CLASSES: ReadonlyMap<string, HostClass> = new Map<string, HostClass>([
  // electron/mcp/worker-capability-preparer.ts, worker-capabilities.ts, client.ts (worker materialization)
  ["worker-capability-preparation-unavailable", "tools_not_ready"], ["worker-capability-credential-or-server-unavailable", "tools_not_ready"],
  ["worker-capability-selection-unavailable", "tools_not_ready"], ["worker-capability-selection-timeout", "tools_not_ready"],
  ["worker-capability-selection-outside-ceiling", "tools_not_ready"], ["worker-capability-inventory-changed", "tools_not_ready"],
  ["worker-capability-lease-released", "tools_not_ready"], ["worker_capabilities_failed", "tools_not_ready"],
  ["worker_capabilities_invalid_lease", "tools_not_ready"], ["worker_capabilities_boundary_widened", "tools_not_ready"],
  ["worker_capabilities_ceiling_not_revalidated", "tools_not_ready"], ["worker_capabilities_release_failed", "tools_not_ready"],
  ["worker-capability-scope-changed", "settings_changed"],
  ["worker-capability-selection-cancelled", "stopped"], ["worker_capabilities_cancelled", "stopped"],
  // electron/mcp/team-goal-context.ts
  ["team_goal_context_changed", "goal_changed"], ["team_goal_revision_mismatch", "goal_changed"], ["team_goal_owner_changed", "goal_changed"],
  ["team_goal_owner_mismatch", "goal_changed"], ["team_goal_checkpoint_mismatch", "goal_changed"], ["team_goal_context_unconfirmed", "goal_changed"],
  ["team_goal_cancelled", "stopped"],
  // electron/mcp/delegated-authority.ts
  ["delegated_authority_invalid_grant", "access_not_granted"], ["delegated_authority_permission_mismatch", "access_not_granted"],
  ["delegated_authority_runner_workspace_mismatch", "access_not_granted"], ["delegated_authority_step_mismatch", "access_not_granted"],
  ["delegated_authority_unrecognized_grant", "access_not_granted"], ["delegated_authority_workspace_mismatch", "access_not_granted"],
  ["delegated_authority_workspace_unavailable", "access_not_granted"], ["delegated_authority_scope_missing", "access_not_granted"],
  // electron/browser/main-browser-channel.ts, electron/mcp/client.ts
  ["native-browser-host-unavailable", "browser_unavailable"], ["agentlas-browser-host-unavailable", "browser_unavailable"],
  // electron/mcp/room-runtime.ts: the room's pinned model cannot take this teammate now (a typed refusal, never a silent swap)
  ["room_runtime_unavailable_for_teammate", "room_model_unavailable"],
]);

const HOST_SENTENCE: Record<HostClass, { ko: (name: string) => string; en: (name: string) => string }> = {
  tools_not_ready: {
    ko: (name) => `${name}은(는) 쓸 도구 연결을 준비하지 못해 이 단계를 시작하지 못했습니다.`,
    en: (name) => `${name} could not start this step because its tool connections were not ready.`,
  },
  settings_changed: {
    ko: (name) => `${name}이(가) 시작하기 전에 목표·접근 권한·도구 목록이 바뀌어 이 단계를 시작하지 않았습니다.`,
    en: (name) => `${name} did not start this step because the Goal, access or tool list changed before it began.`,
  },
  goal_changed: {
    ko: (name) => `${name}이(가) 일하는 동안 목표가 바뀌어 이 단계를 멈췄습니다.`,
    en: (name) => `The Goal changed while ${name} was working, so this step was stopped.`,
  },
  stopped: {
    ko: (name) => `${name}의 이 단계는 중단되었습니다.`,
    en: (name) => `${name}'s step was stopped.`,
  },
  access_not_granted: {
    ko: (name) => `${name}에게 이 단계에 필요한 접근 권한이 주어지지 않아 시작하지 않았습니다.`,
    en: (name) => `${name} did not start this step because the access it needs was not granted to it.`,
  },
  room_model_unavailable: {
    ko: (name) => `이 방에서 고른 모델을 ${name}이(가) 지금 쓸 수 없어 이 단계를 시작하지 않았습니다. 다른 모델로 바꿔 실행하지는 않았습니다.`,
    en: (name) => `The model chosen for this room is not available for ${name} right now, so this step was not started. No other model was used instead.`,
  },
  browser_unavailable: {
    ko: (name) => `${name}에 필요한 로그인된 Agentlas Browser를 지금 쓸 수 없어 이 단계를 시작하지 못했습니다. Agentlas Browser를 열어 로그인하면 이후 단계부터 쓸 수 있습니다.`,
    en: (name) => `${name} needs the signed-in Agentlas Browser, which is not available right now, so this step could not start. Opening Agentlas Browser and signing in makes it usable for later steps.`,
  },
};

/** The provider-owned classes of shared/run-failure-notice.ts, worded for one worker of a team (not for the whole run). */
// `when` is the provider-reported reset sentence (formatRuntimeQuotaReset) when the typed failure carries a valid retryAfterAt. A step stopped
// by a limit or an outage is a fact about the step. What the host does about it is not decided here: the room has already tried every other
// model of its pool, and the turn that carries the step keeps the request and continues it when the cause clears (invocation/host-recovery.ts,
// or the room's Goal), with its own line. So these sentences state the cause and the reset time only: they never say "recorded as failed",
// never ask the owner to pick another model, and never promise a continuation they cannot see.
type ProviderSentence = { ko: (name: string, when?: string | null) => string; en: (name: string, when?: string | null) => string };
const withWhen = (sentence: string, when?: string | null): string => (when ? `${sentence} ${when}` : sentence);
const PROVIDER_SENTENCE: Partial<Record<RunFailureNoticeCause, ProviderSentence>> = {
  quota: { ko: (name, when) => withWhen(`${name}이(가) 쓰는 모델의 사용 한도가 소진되어 이 단계를 마치지 못했습니다.`, when),
    en: (name, when) => withWhen(`The usage limit of the model ${name} uses is used up, so this step could not finish.`, when) },
  rate_limit: { ko: (name, when) => withWhen(`${name}이(가) 쓰는 모델 공급자가 요청 속도를 제한해 이 단계를 마치지 못했습니다.`, when),
    en: (name, when) => withWhen(`The provider of the model ${name} uses rate-limited the request, so this step could not finish.`, when) },
  auth: { ko: (name) => `${name}이(가) 쓰는 모델의 로그인이 필요하거나 만료되어 이 단계를 마치지 못했습니다. 설정에서 다시 연결해 주세요.`,
    en: (name) => `The sign-in of the model ${name} uses is needed or expired, so this step could not finish. Reconnect it in Settings.` },
  refused: { ko: (name) => `${name}이(가) 쓰는 모델 공급자가 이 단계의 응답을 거절했습니다.`,
    en: (name) => `The provider of the model ${name} uses declined to answer this step.` },
  empty: { ko: (name) => `${name}이(가) 쓰는 모델이 빈 답을 돌려줘 이 단계를 마치지 못했습니다.`,
    en: (name) => `The model ${name} uses returned an empty answer, so this step could not finish.` },
  empty_no_tool: { ko: (name) => `${name}이(가) 쓰는 모델이 답도 도구 호출도 없이 끝나 이 단계를 마치지 못했습니다.`,
    en: (name) => `The model ${name} uses ended with no answer and no tool call, so this step could not finish.` },
  tools_unusable: { ko: (name) => `${name}이(가) 호출한 도구가 모두 실패했고 답이 없어 이 단계를 마치지 못했습니다.`,
    en: (name) => `Every tool call ${name} made failed and no answer followed, so this step could not finish.` },
  unavailable: { ko: (name) => `${name}이(가) 쓰는 Agentlas 모델 서비스를 지금 사용할 수 없어 이 단계를 마치지 못했습니다.`,
    en: (name) => `The Agentlas model service ${name} uses is unavailable right now, so this step could not finish.` },
  provider_unavailable: { ko: (name) => `${name}이(가) 쓰는 모델 공급자가 지금 요청을 받을 수 없어(서비스 장애 또는 수용 한도 초과) 이 단계를 마치지 못했습니다.`,
    en: (name) => `The provider of the model ${name} uses could not take the request right now (an outage or no free capacity), so this step could not finish.` },
  provider_connection: { ko: (name) => `${name}이(가) 쓰는 모델 공급자에 연결하지 못해 이 단계를 마치지 못했습니다.`,
    en: (name) => `The model provider ${name} uses could not be reached, so this step could not finish.` },
  runtime_unavailable: { ko: (name) => `${name}에 배정된 모델을 지금 쓸 수 없어 이 단계를 마치지 못했습니다.`,
    en: (name) => `The model assigned to ${name} is not available right now, so this step could not finish.` },
  capacity: { ko: (name) => `${name}의 이 단계 입력이 모델의 입력(컨텍스트) 한도를 넘어 마치지 못했습니다.`,
    en: (name) => `This step's input was larger than the context limit of the model ${name} uses, so it could not finish.` },
  subscription_credits_off: { ko: (name) => `${name}이(가) 쓰는 구독의 사용 한도에 도달했고 크레딧 자동 사용이 꺼져 있어 이 단계를 시작하지 않았습니다.`,
    en: (name) => `The subscription limit of the model ${name} uses is reached and automatic credit use is off, so this step was not started.` },
  unsettled: { ko: () => "응답이 끝나기 전에 멈춰 이 단계를 마치지 못했습니다.", en: () => "This step stopped before its reply finished." },
  // The host-owned classes of the run-level notice that had no worker sentence, so a teammate that ended with one read the neutral line
  // below instead of the cause (E22). The tool and Goal-state classes reuse the host sentences above: one wording per cause.
  tool_missing: { ko: (name) => `${name}에게 필요한 도구(이미지 생성)가 이 앱에 연결돼 있지 않아 이 단계를 마치지 못했습니다. 설정에서 이미지 모델을 연결해 주세요.`,
    en: (name) => `A tool ${name} needs (image generation) is not connected in this app, so this step could not finish. Connect an image model in Settings.` },
  tool_failed: { ko: (name) => `${name}이(가) 쓴 이미지 생성 도구가 결과를 만들지 못해 이 단계를 마치지 못했습니다.`,
    en: (name) => `The image generation tool ${name} used produced no result, so this step could not finish.` },
  tools_unprepared: { ko: (name) => HOST_SENTENCE.tools_not_ready.ko(name), en: (name) => HOST_SENTENCE.tools_not_ready.en(name) },
  browser_host_unavailable: { ko: (name) => HOST_SENTENCE.browser_unavailable.ko(name), en: (name) => HOST_SENTENCE.browser_unavailable.en(name) },
  goal_changed: { ko: (name) => HOST_SENTENCE.settings_changed.ko(name), en: (name) => HOST_SENTENCE.settings_changed.en(name) },
  runtime_changed: { ko: (name) => `${name}이(가) 쓸 모델이 확인한 모델과 달라 이 단계를 실행하지 않았습니다.`,
    en: (name) => `The model ${name} would use differs from the one you confirmed, so this step was not run.` },
  store_busy: { ko: (name) => `Agentlas 저장소가 다른 기록으로 잠겨 있어 ${name}의 이 단계를 끝까지 기록하지 못했습니다.`,
    en: (name) => `The Agentlas store was locked by another write, so ${name}'s step could not be fully recorded.` },
  project_busy: { ko: (name) => `이 Work 프로젝트의 다른 채팅에서 에이전트가 아직 실행 중이라 ${name}의 이 단계를 시작하지 않았습니다.`,
    en: (name) => `An agent is still running in another chat of this Work project, so ${name}'s step was not started.` },
  session_reopen: { ko: (name) => `${name}의 이전 실행 세션을 다시 열지 못해 이 단계를 시작하지 못했습니다.`,
    en: (name) => `${name}'s previous run session could not be reopened, so this step was not started.` },
  working_folder: { ko: (name) => `${name}의 작업 폴더를 쓸 수 없어(없거나, 폴더가 아니거나, 열 수 없습니다) 이 단계를 시작하지 못했습니다.`,
    en: (name) => `${name}'s working folder cannot be used (it is missing, is not a folder, or cannot be opened), so this step was not started.` },
};
/** Reasons the provider states in its own words (reset time, plan, policy) stay visible after the app-language sentence. */
const QUOTES_PROVIDER_REASON: ReadonlySet<RunFailureNoticeCause> = new Set<RunFailureNoticeCause>(["quota", "rate_limit", "auth", "refused"]);

const GENERIC = {
  ko: (name: string) => `${name}이(가) 이 단계를 끝까지 진행하지 못했습니다.`,
  en: (name: string) => `${name} could not finish this step.`,
} as const;

const CODE_RE = /^[A-Za-z][A-Za-z0-9]*(?:[_.:-][A-Za-z0-9]+)*$/;

/** The first host code in the failure and its cause chain that the closed table names (own `code`, or a message that is itself a code). */
export function teamWorkerHostFailureCode(error: unknown): string | null {
  return firstCodeInChain(error, TEAM_WORKER_HOST_FAILURE_CLASSES);
}

function firstCodeInChain(error: unknown, table: ReadonlyMap<string, unknown>): string | null {
  const seen = new Set<object>();
  const queue: unknown[] = [error];
  for (let count = 0; queue.length && count < 8; count += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const row = value as { code?: unknown; message?: unknown; cause?: unknown };
    for (const candidate of [row.code, typeof row.message === "string" ? row.message.trim() : undefined]) {
      if (typeof candidate === "string" && candidate.length <= 96 && CODE_RE.test(candidate) && table.has(candidate)) return candidate;
    }
    queue.push(row.cause);
  }
  return null;
}

export interface TeamWorkerFailureFacts {
  locale: TeamWorkerFailureLocale;
  /** The worker's display name. */
  name: string;
  /** The thrown error: only its typed code and cause chain are read. */
  error?: unknown;
  /** The typed provider failure behind the error, when the runner reported one. */
  runtimeFailure?: { kind: string; source: "marker" | "exit" | "heuristic"; providerCode?: string; message?: string; retryAfterAt?: string } | null;
}

/** The sentence for one failed worker: a host code's class, else the typed provider class, else one neutral line. */
export function teamWorkerFailureText(facts: TeamWorkerFailureFacts): string {
  const locale = facts.locale === "ko" ? "ko" : "en";
  const name = facts.name.trim() || (locale === "ko" ? "이 팀원" : "This teammate");
  // A host-owned code in the error chain, else the host-owned provider code of the typed failure (both from the same closed table).
  const hostCode = teamWorkerHostFailureCode(facts.error)
    ?? (facts.runtimeFailure?.providerCode && TEAM_WORKER_HOST_FAILURE_CLASSES.has(facts.runtimeFailure.providerCode) ? facts.runtimeFailure.providerCode : null);
  const hostClass = hostCode ? TEAM_WORKER_HOST_FAILURE_CLASSES.get(hostCode) : undefined;
  if (hostClass) return HOST_SENTENCE[hostClass][locale](name);
  const failure = facts.runtimeFailure;
  if (failure) {
    const cause = runFailureNoticeCause({
      errorCode: failure.providerCode ?? null,
      runtimeFailure: { kind: failure.kind as "quota" | "rate_limit" | "auth" | "refused" | "empty", source: failure.source,
        ...(failure.providerCode ? { providerCode: failure.providerCode } : {}) },
    });
    const when = cause === "quota" || cause === "rate_limit" ? formatRuntimeQuotaReset(failure.retryAfterAt, locale) : null;
    const sentence = cause ? PROVIDER_SENTENCE[cause]?.[locale](name, when) : undefined;
    if (sentence && cause) {
      const detail = QUOTES_PROVIDER_REASON.has(cause) ? boundedFailureDetail(failure.message) : null;
      return detail ? `${sentence} ${locale === "ko" ? "보고된 사유" : "Reported reason"}: “${detail}”` : sentence;
    }
  }
  // No typed provider failure carried the cause, but the error chain itself holds a host-owned code the run-level notice names (the same
  // closed table, shared/run-failure-notice.ts HOST_FAILURE_CODE_CLASSES): the same cause, worded for one worker.
  const sharedCode = firstCodeInChain(facts.error, HOST_FAILURE_CODE_CLASSES);
  const sharedCause = sharedCode ? runFailureNoticeCause({ errorCode: sharedCode }) : null;
  const sharedSentence = sharedCause ? PROVIDER_SENTENCE[sharedCause]?.[locale](name) : undefined;
  if (sharedSentence) return sharedSentence;
  return GENERIC[locale](name);
}

/**
 * The host appends the typed execution-failure JSON to a failed worker's text (the synthesizer and the ledger read it; the
 * line is exactly `JSON.stringify(report)` and starts with the schema marker). It is machine data, never room prose: the
 * transcript shows the worker's text without it. Recognised by that signature only.
 */
export function withoutExecutionFailureReport(text: string): string {
  return text.split("\n").filter((line) => !line.startsWith('{"schemaVersion":"agentlas.execution-failure.v1"')).join("\n").trim();
}

/**
 * The host's marker between a failed firm node's sentence and the recovery evidence behind it (partial text, tool counts, the typed
 * report). The evidence is for the CEO's synthesis and the ledger; the owner's room shows the sentence. It must equal the literal in
 * firm-orchestrator.ts firm.failure-checkpoint.base, which stays a literal so the frozen-prompt gate can read the declaration.
 */
export const FIRM_FAILURE_CHECKPOINT_MARKER = "[Partial execution checkpoint — this is recovery evidence, not a completed deliverable]";

/** What a team message shows the owner: a failed node's sentence without its recovery evidence or typed report. */
export function ownerVisibleTeamMessage(text: string): string {
  const cut = text.indexOf(FIRM_FAILURE_CHECKPOINT_MARKER);
  return withoutExecutionFailureReport(cut >= 0 ? text.slice(0, cut) : text);
}
