import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { createRuntimeRetryStore, type RetryGoal, type RetryResource } from "../store/runtime-retry";
import type { Runner, RunnerRequest, RunnerResult } from "./runner";
import { runnerRefusedBeforeDispatch, runnerResultRefusedBeforeDispatch } from "./runner-pre-dispatch";
import { parseRetryHint } from "./runtime-cooldown";
import type { RuntimeStatus } from "../../shared/types";
import { withRuntimeRetryObservation } from "./retry-observation";
import { httpRetryAfterTimestamp } from "./http-retry-after";
import { MAX_TRANSIENT_RETRIES } from "../long-run/pass-failure-verdict";

const store = createRuntimeRetryStore(getDb);
type Selection = Pick<RuntimeStatus, "kind" | "backend" | "source" | "model"> & { acpAgentId?: string | null; configuration?: string };

export function durableRetryResource(selection: Selection, req?: RunnerRequest): RetryResource {
  // This uses the existing host custody identity. No renderer-supplied account or Goal id
  // is accepted, and neither credentials nor endpoint/configuration text is persisted.
  const host = require("./agent-context-admission") as typeof import("./agent-context-admission");
  const custody = host.agentContextOwnerBinding();
  // CLI/BYOK/local credentials belong to this configured installation, not the
  // transient Agentlas sign-in cache (which is empty early after restart).
  const owner = selection.kind === "agentlas" ? custody.ownerScope : custody.serviceIdentity;
  let configuration: string | null = null;
  if (selection.kind === "ollama") configuration = (require("./local-host") as typeof import("./local-host")).ollamaHost();
  if (selection.kind === "lmstudio") configuration = (require("./lmstudio") as typeof import("./lmstudio")).lmStudioHost();
  if (selection.kind === "mlx") configuration = (require("./mlx") as typeof import("./mlx")).mlxHost();
  if (selection.kind === "agentlas") configuration = (require("../auth") as typeof import("../auth")).webBaseUrl();
  if (selection.kind === "byok" && selection.backend === "custom" && selection.configuration === undefined) {
    const custom = require("./custom-base-url") as typeof import("./custom-base-url");
    configuration = custom.readCustomBaseUrl() ?? custom.DEFAULT_CUSTOM_BASE_URL;
  }
  if (selection.configuration !== undefined) configuration = selection.configuration;
  let model = req?.model ?? selection.model ?? null;
  if (selection.kind === "ollama" && model && !/[@?#\s]/.test(model) && !model.includes("://")
    && !model.endsWith(":") && !model.endsWith("/") && model.lastIndexOf(":") <= model.lastIndexOf("/")) model += ":latest";
  return { owner, kind: selection.kind, backend: selection.backend, source: selection.source, model, acpAgentId: selection.acpAgentId, configuration };
}

/**
 * The Goal episode this provider call is counted against, or undefined: the call then runs uncounted. This boundary only keeps the
 * Goal's retry budget; it never refuses a call. Whether a turn may run at all for its Goal's state (an owner pause, a hold for the
 * owner's answer, a stop) is decided once, where the turn is admitted (invocation/service.ts, the blocked-goal sweep, startup
 * checkpoints, wait subscriptions). Refusing here as well stopped calls that admission had let through, each with an internal code
 * the owner saw as a failure: a phone answer (not_runnable, Thread Marketing), a team's planning call that carries no
 * agent-context binding (binding_missing, X Marketing), and the same for any Goal state no rule here had foreseen.
 */
function goal(req: RunnerRequest): RetryGoal | undefined {
  try {
    if (!req.agentContext || !req.chatId) return undefined;
    const { agentContextHostBinding } = require("./agent-context") as typeof import("./agent-context");
    agentContextHostBinding(req.agentContext).assertCurrent();
    const row = getDb().prepare(`SELECT c.goal_id, l.id AS run_id, l.status FROM chats c LEFT JOIN long_runs l
      ON l.goal_id=c.goal_id AND l.root_chat_id=c.id WHERE c.id=?`).get(req.chatId) as
      { goal_id: string | null; run_id: string | null; status: string | null } | undefined;
    if (!row?.goal_id || !row.run_id || !["queued", "running", "waiting_tool"].includes(row.status ?? "")) return undefined;
    // The host decided this run is not the Goal's episode (an owner message to a stopped Goal's room).
    const { isOrdinaryGoalTurn } = require("./goal-ordinary-turns") as typeof import("./goal-ordinary-turns");
    if (isOrdinaryGoalTurn(invocationId(req))) return undefined;
    const { longRunOwnerHold, goalOwnerAnswerHold } = require("../store/long-runs") as typeof import("../store/long-runs");
    if (longRunOwnerHold(row.run_id) || goalOwnerAnswerHold(row.run_id)) return undefined;
    const { getChatGoalRevision } = require("../store/chat-goals") as typeof import("../store/chat-goals");
    const revision = getChatGoalRevision(row.goal_id);
    return revision ? { goalId: row.goal_id, revision: revision.revision } : undefined;
  } catch {
    // A binding or ledger that cannot be read leaves the call uncounted; it is never the reason the call fails.
    return undefined;
  }
}

function invocationId(req: RunnerRequest): string | null {
  if (!req.agentContext || !req.chatId) return null;
  const { agentContextHostBinding } = require("./agent-context") as typeof import("./agent-context");
  const binding = agentContextHostBinding(req.agentContext);
  binding.assertCurrent();
  if (!binding.turnId.startsWith("agent-context-turn:")) return null;
  const ref: unknown = JSON.parse(binding.turnId.slice("agent-context-turn:".length));
  return Array.isArray(ref) && ref[0] === req.chatId && typeof ref[1] === "string" ? ref[1] : null;
}

/** Candidate filtering is advisory; the runner boundary below always rechecks durably. */
export function durableRuntimeWindow(selection: Selection, now = Date.now()) {
  return store.window(durableRetryResource(selection), now);
}

/** Count survives a new invocation/restart, but success or a genuinely different resource has its own episode. */
export function durableGoalFailureAttempts(req: RunnerRequest, selection: Selection, hostGoalId?: string | null): number {
  let bound = goal(req);
  // The client owns activeGoalId, but its pre-binding request object is not the
  // final runner request. Reading an account grants no provider authority.
  if (!bound && hostGoalId) {
    const { getChatGoalRevision } = require("../store/chat-goals") as typeof import("../store/chat-goals");
    const revision = getChatGoalRevision(hostGoalId);
    if (revision) bound = { goalId: hostGoalId, revision: revision.revision };
  }
  return bound ? store.failures(durableRetryResource(selection, req), bound) : 0;
}

/** Final common host runner boundary. Runs for all subscription/API/local adapters, including daemon serving. */
export function withDurableRuntimeRetry(runner: Runner, selected: Selection,
  modelForRequest?: (request: RunnerRequest) => string | undefined): Runner {
  const selection = { ...selected };
  return async (req, events) => {
    req.signal?.throwIfAborted();
    const identityRequest = modelForRequest ? { ...req, model: modelForRequest(req) } : req;
    const target = durableRetryResource(selection, identityRequest);
    // The run id only names where a wait or a closed budget is recorded; an unreadable binding leaves it unnamed, never a failure.
    let runId: string | null = null;
    try { runId = invocationId(req); } catch { runId = null; }
    let bound = goal(req);
    if (bound && store.budgetExhausted(target,bound)) {
      if (runId) store.closeRunBudget(runId);
      return { text: "", turnDelivery: "not-dispatched", failure: {
      kind: "unavailable", runtime: selection.kind, source: "marker", providerCode: "runtime_retry_budget_exhausted",
      retryBudgetExhausted: true, message: "" } };
    }
    const resourceWait = store.window(target);
    const goalWait = bound ? store.goalFloor(bound) : null;
    // Unrepresentable calendar floors are an external refusal, never an early call.
    const wait = resourceWait ?? (goalWait && goalWait.until > Date.UTC(9999, 11, 31, 23, 59, 59, 999) ? goalWait : null);
    if (wait) {
      if (runId) store.recordRunWait(runId, wait);
      if (bound) store.holdGoal(bound, wait.until, wait.kind, "provider-wait");
      return { text: "", turnDelivery: "not-dispatched", failure: {
      kind: wait.kind, runtime: selection.kind, source: "marker", providerCode: "runtime_retry_not_before",
      retryAfterHint: new Date(wait.until).toISOString(),
      message: "",
      } };
    }
    const callId = randomUUID();
    // The Goal changed between counting and the call (a revision, a stop): the call is no longer this episode's, so its
    // reservation is given back and it runs uncounted. Never a refusal (see goal()).
    const GOAL_CHANGED = Symbol("goal-changed");
    const assertBound = () => {
      req.signal?.throwIfAborted();
      const current = goal(req);
      if (!bound || !current || current.goalId !== bound.goalId || current.revision !== bound.revision) throw GOAL_CHANGED;
    };
    let generation: number | null = 0;
    if (bound) {
      try { generation = store.admit(target,bound,callId,MAX_TRANSIENT_RETRIES+1,assertBound); }
      catch (error) { if (error !== GOAL_CHANGED) throw error; bound = undefined; generation = 0; }
    }
    if (generation === null) {
      if (runId) store.closeRunBudget(runId);
      return {text:"",turnDelivery:"not-dispatched",failure:{kind:"unavailable",runtime:selection.kind,
      source:"marker",providerCode:"runtime_retry_budget_exhausted",retryBudgetExhausted:true,
      message:""}};
    }
    // The reservation above is spent unless a machine fact proves the call never reached the provider. Only then it is
    // given back, once (store.refund); a refund that cannot be written leaves it spent, never duplicated.
    const refundReservation = () => {
      if (!bound) return;
      try { store.refund(target, bound, callId, MAX_TRANSIENT_RETRIES + 1); } catch { /* stays spent */ }
    };
    try {
      req.signal?.throwIfAborted();
      if (bound) assertBound();
    } catch (error) {
      // Aborted, or the Goal changed, between the reservation and entering the runner: nothing was sent.
      refundReservation();
      if (error !== GOAL_CHANGED) throw error;
      bound = undefined;
    }
    let observedGeneration: number | undefined;
    let result: RunnerResult;
    try {
      result = await withRuntimeRetryObservation((status, header) => {
        const notBefore = httpRetryAfterTimestamp(header);
        if (notBefore === null) return;
        const kind = status === 429 ? "rate_limit" : "unavailable";
        observedGeneration = store.failure(target, { kind, notBefore, callId, ...(bound ? { goal: bound,
          budget: { maxFailures: MAX_TRANSIENT_RETRIES + 1 } } : {}) }) ?? observedGeneration;
        if (runId) store.recordRunWait(runId, { until: notBefore, kind });
      }, () => runner(req, events));
    } catch (error) {
      // A thrown refusal the runner typed as pre-dispatch (turnDelivery "not-dispatched") reached no provider. Any other
      // throw (abort mid-call, transport error) has unknown delivery, so the attempt stays spent.
      if (observedGeneration === undefined && runnerRefusedBeforeDispatch(error)) refundReservation();
      throw error;
    }
    if (result.failure) {
      // A local admission refusal did not spend a provider attempt. In particular, a fresh
      // invocation never replenishes the existing pass retry allowance by re-reading a wait.
      if (result.failure.providerCode !== "runtime_retry_not_before"
        && ["quota", "rate_limit", "unavailable", "timeout", "empty", "exit"].includes(result.failure.kind)) {
        const notBefore = parseRetryHint(result.failure.retryAfterHint, Date.now());
        const spentAttempt = result.turnDelivery !== "not-dispatched" || /^http_(429|5\d\d)$/.test(result.failure.providerCode ?? "");
        store.failure(target, { kind: result.failure.kind, notBefore, callId, ...(bound && spentAttempt ? { goal: bound,
          budget: { maxFailures: MAX_TRANSIENT_RETRIES + 1 } } : {}) });
        if (runId && notBefore !== null) store.recordRunWait(runId, { until: notBefore, kind: result.failure.kind });
      }
      // The runner proved (turnDelivery "not-dispatched") that nothing reached the provider: the reservation is returned,
      // for every failure kind. An HTTP 429/5xx answer or a header the transport observed means the provider was reached.
      if (runnerResultRefusedBeforeDispatch(result) && observedGeneration === undefined
        && !/^http_(429|5\d\d)$/.test(result.failure.providerCode ?? "")) refundReservation();
    } else if (bound && !req.signal?.aborted) store.success(target, bound, observedGeneration ?? generation);
    req.signal?.throwIfAborted();
    if (result.failure && bound && store.budgetExhausted(target,bound)) {
      if (runId) store.closeRunBudget(runId);
      result.failure = { ...result.failure, retryBudgetExhausted: true };
    }
    return result;
  };
}

/** Private schedule floor; public/mobile Goal DTOs do not carry this metadata. */
export function durableGoalRetryFloor(goalId: string, revision: number, now = Date.now()): number | null {
  return store.goalFloor({ goalId, revision }, now)?.until ?? null;
}
