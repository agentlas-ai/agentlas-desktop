/**
 * AGI goal manager, P4 — the model-backed unblock attempt (plan §3.3, R8/R4/R6).
 *
 * One bounded model attempt per claimed incident retry, on the judgment no-tools path (the same isolation the
 * Alive light wake uses: no shell, no MCP, strict output schema). The model gets fresh evidence first (R8): the host
 * reads the P2 tools for this goal and packs the capped, redacted slices into the prompt. It may ask for up to
 * AGI_MAX_EXTRA_READS more P2 reads once (a second and last round). It answers only with typed P3 actions, which Main
 * executes through the executor with every structural guard (fence, G1, purpose_change, circuit breaker, budget).
 *
 * Model order (D4): the goal's own runtime first (the runtime its latest controller attempt ran on), then the owner's
 * role-pool order. Eligible refusals fall to the next candidate without erasing unknown usage. Budget (D1): the
 * attempt cap and the goal's daily cap are admitted before each call with a size estimate and charged with the
 * measured usage afterwards, also against the goal's Alive grant.
 */
import { agiDecisionRefusal, agiDecisionAbortSignal, AGI_DECISION_CONTROL_CHANGED } from "./decision-control";
import { currentUiLocale } from "../ui-locale";
import type Database from "better-sqlite3";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerFailure } from "../runtime/runner";
import { isJudgmentRefusal } from "../runtime/judgment-refusal";
import { createObservedUsageAccumulator, createRuntimeUsageCollector } from "../../shared/observed-usage";
import { AGI_ACTION_KINDS, AGI_NON_ALTERNATIVE_ACTIONS, type AgiActionKind } from "./blocker";
import { AGI_ACTION_SCHEMA, AGI_MAX_ACTIONS_PER_ATTEMPT, type AgiActionExecutor, type AgiActionReceipt } from "./actions";
import { admitAgiTokens, chargeAgiTokens, readAgiTokenLimits } from "./budget";
import { AGI_READ_TOOL_NAMES, type AgiReadResult } from "./read-tools";
import type { AgiUnblockInput, AgiUnblockResult } from "./monitor";

export const AGI_MODEL_ATTEMPT_SCHEMA = "agentlas.agi-unblock-decision.v1" as const;
export const AGI_MAX_EXTRA_READS = 4;
export const AGI_MODEL_OUTPUT_TOKENS = 4_000;
export const AGI_MODEL_TIME_LIMIT_MS = 5 * 60_000;
/** Candidate failover does not prove that the prior provider charged zero. */
const NEXT_CANDIDATE_FAILURES = new Set(["quota", "auth", "unsupported"]);

export interface AgiModelCandidate { selection: RuntimeSelection; status: RuntimeStatus; label: string; source: "goal" | "pool" }

export interface AgiModelAttemptDeps {
  db: Database.Database;
  now(): number;
  candidates(goalId: string): AgiModelCandidate[] | Promise<AgiModelCandidate[]>;
  pickRunner(status: RuntimeStatus): { runner: Runner; label: string } | null;
  noteFailure?(status: RuntimeStatus, failure: RunnerFailure): void;
  read(goalId: string, tool: string, args: Record<string, unknown>): AgiReadResult;
  /** Installed alternative tool paths (retry_node_with may only name one of these). */
  installedPaths(): string[];
  executor: AgiActionExecutor;
  timeoutMs?: number;
}

export function ensureAgiModelAttemptSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_model_attempts (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, incident_id TEXT NOT NULL, state_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','refused')),
    runtime_json TEXT, rounds INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,
    actions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(actions_json)), code TEXT,
    created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_model_running_goal ON agi_model_attempts(goal_id) WHERE status='running'");
}

/** Strict JSON schema for the model answer (every property required for strict-mode runtimes). */
export const AGI_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["schema", "diagnosis", "reads", "actions", "reflection"],
  properties: {
    schema: { type: "string", enum: [AGI_MODEL_ATTEMPT_SCHEMA] },
    diagnosis: { type: "object", additionalProperties: false, required: ["summary", "ownerClass"],
      properties: { summary: { type: "string" }, ownerClass: { type: "string", enum: ["our_defect", "agent_resolvable", "human_only"] } } },
    reads: { type: "array", maxItems: AGI_MAX_EXTRA_READS, items: { type: "object", additionalProperties: false, required: ["tool", "argsJson"],
      properties: { tool: { type: "string", enum: [...AGI_READ_TOOL_NAMES] }, argsJson: { type: "string" } } } },
    actions: { type: "array", maxItems: AGI_MAX_ACTIONS_PER_ATTEMPT + 1, items: { type: "object", additionalProperties: false, required: ["action", "argsJson"],
      properties: { action: { type: "string", enum: [...AGI_ACTION_KINDS] }, argsJson: { type: "string" } } } },
    reflection: { type: "string" },
  },
};

const SYSTEM_PROMPT = `You are Agentlas AGI, the goal manager and unblocker for ONE stuck goal. The host (Main) observed a typed blocker
and gives you capped, redacted evidence. You have NO tools and NO shell. You answer only with the JSON schema.
Your job: clear the block or route around it so the goal keeps moving, choosing ONLY from typed actions. Rules:
- Every action is executed by the host with guards; a refused action changes nothing. Up to ${AGI_MAX_ACTIONS_PER_ATTEMPT} actions.
- Never ask the owner for something an agent can do. ask_owner_once is only for a real boundary
  (payment, credential, security_consent, purpose_change), only AFTER an alternative path in the same answer or earlier
  (e.g. continue the zero-cost path first), and at most once per boundary. owner_stop is never asked.
- The goal's intent (mission, done_when, objective) is the owner's. replan_tree may split (only a tactic that already
  failed), merge duplicates within a strategy, retire, or reorder. Never change intent.
- If the plan needs a role nobody on the team has, create_teammate (then invite_teammate in group chats) and
  dispatch_teammate the concrete work bound to an active tactic id. Teammates may be created without asking.
- Uncertain outward effects: never redo them. settle_uncertain_effect may reuse only an evidenceRef
  "run:<observationRunId>" whose Main observation receipt already confirmed exactly those attemptIds.
  A later successful tool, browser read or final message is not proof. Independent work can continue while the
  read-only observation controller checks the original targets.
- A login wall: run_login_recovery(domain) first. A dead Agentlas Browser: restart_agentlas_browser. The app itself:
  request_app_restart (asks once; never restarts by itself).
- A tool path that crashed: retry_node_with(nodeId, capability, path) naming one installed path from the evidence.
- Our own product defect: file_defect(code, category, evidenceRefs, workaround) — it is only recorded locally.
- If you need more evidence first, put up to ${AGI_MAX_EXTRA_READS} read requests in "reads" and leave "actions" empty; you get
  exactly one more round. In the second round "reads" must be empty.
- argsJson is a JSON object string with the action's arguments, e.g. {"name":"Blender Animator","role":"3D animation"}.
Action arguments: settle_uncertain_effect{attemptIds[],evidenceRef}; create_teammate{name,role?,personality?};
invite_teammate{member}; dispatch_teammate{member,brief,nodeId}; switch_runtime{reason}; retry_node_with{nodeId,capability,path};
replan_tree{ops:[{op:"split",nodeId,into:[{description}]}|{op:"merge",keep,retire[]}|{op:"retire",nodeId}|{op:"reorder",nodeId,ord}]};
start_work_turn{nodeId}; run_login_recovery{domain}; restart_agentlas_browser{}; request_app_restart{reason};
file_defect{code,category,evidenceRefs[],workaround?}; ask_owner_once{boundary,ask,resumesWith}; rest{untilIso?,reason}.
reflection: one sentence "tried X, evidence Y, ruled out Z" for the incident record.`;

/** Host execution order: alternatives first, the work turn after the changes it depends on, the ask last. */
const EXECUTION_ORDER: AgiActionKind[] = ["settle_uncertain_effect", "run_login_recovery", "restart_agentlas_browser", "create_teammate",
  "invite_teammate", "dispatch_teammate", "replan_tree", "retry_node_with", "switch_runtime", "start_work_turn", "file_defect",
  "request_app_restart", "ask_owner_once", "rest"];

interface Decision {
  reads: Array<{ tool: string; args: Record<string, unknown> }>;
  actions: Array<{ action: AgiActionKind; args: Record<string, unknown> }>;
  reflection: string;
}

function parseArgs(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) return {};
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

export function parseAgiDecision(text: string): Decision | null {
  let raw: unknown;
  try {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    raw = JSON.parse(start > 0 ? trimmed.slice(start, trimmed.lastIndexOf("}") + 1) : trimmed);
  } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.schema !== AGI_MODEL_ATTEMPT_SCHEMA) return null;
  const reads = (Array.isArray(value.reads) ? value.reads : []).slice(0, AGI_MAX_EXTRA_READS)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => (AGI_READ_TOOL_NAMES as readonly string[]).includes(String(entry.tool)))
    .map((entry) => ({ tool: String(entry.tool), args: parseArgs(entry.argsJson) }));
  const actions = (Array.isArray(value.actions) ? value.actions : []).slice(0, AGI_MAX_ACTIONS_PER_ATTEMPT + 1)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => (AGI_ACTION_KINDS as readonly string[]).includes(String(entry.action)))
    .map((entry) => ({ action: entry.action as AgiActionKind, args: parseArgs(entry.argsJson) }));
  return { reads, actions, reflection: typeof value.reflection === "string" ? value.reflection.slice(0, 400) : "" };
}

/** Evidence the host reads before any model call (R8), chosen from the diagnosis, all through the P2 tools. */
export function agiEvidenceReads(input: AgiUnblockInput): Array<{ tool: string; args: Record<string, unknown> }> {
  const d = input.diagnosis;
  const reads: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "goal_state", args: {} },
    { tool: "incident", args: { incidentId: input.incidentId } },
    { tool: "goal_ledger_events", args: {} },
    { tool: "attempt_receipts", args: {} },
    { tool: "team_roster", args: {} },
    { tool: "chat_tail", args: { n: 8 } },
  ];
  const runRef = [...d.evidenceRefs].reverse().map((ref) => /^run:([A-Za-z0-9._:@-]+?)(?::tool:.*)?$/.exec(ref)?.[1]).find(Boolean);
  if (runRef) reads.push({ tool: "tool_ledger", args: { runId: runRef } });
  const family = d.primarySignal === "browser_unavailable" ? "cdp" : d.primarySignal === "login_wall" ? "login"
    : d.primarySignal === "tool_crash" ? "blender" : d.primarySignal === "wait_registration_refused" || d.causeKind === "effect_uncertain" ? "wait"
      : d.primarySignal === "run_failed" ? "runtime" : null;
  if (family) reads.push({ tool: "main_log_slice", args: { family } });
  return reads;
}

function estimateTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 3); }

const activeRepairs = new WeakMap<object, Set<string>>();

export class AgiModelAttempt {
  isRunning(goalId: string): boolean {
    return activeRepairs.get(this.deps.db)?.has(goalId) === true || Boolean(this.deps.db.prepare(
      "SELECT 1 FROM agi_model_attempts WHERE goal_id=? AND status='running' LIMIT 1").get(goalId));
  }

  async run(input: AgiUnblockInput, preActions: Array<{ action: string; result: string }> = []): Promise<AgiUnblockResult & { attemptId: string }> {
    if (this.isRunning(input.goalId)) return { attemptId: "", outcome: "rested", code: "agi.model.in-flight" };
    const active = activeRepairs.get(this.deps.db) ?? new Set<string>();
    activeRepairs.set(this.deps.db, active);
    active.add(input.goalId);
    try { return await this.runAttempt(input, preActions); }
    finally { active.delete(input.goalId); }
  }

  constructor(private readonly deps: AgiModelAttemptDeps) { ensureAgiModelAttemptSchema(deps.db); }

  private evidenceBlock(goalId: string, reads: Array<{ tool: string; args: Record<string, unknown> }>, controlRefusal: () => string | null): string {
    return reads.map(({ tool, args }) => {
      const refusal = controlRefusal();
      if (refusal) return JSON.stringify({ refused: refusal });
      const result = this.deps.read(goalId, tool, args);
      return `### ${tool}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""}\n${result.ok ? result.text : JSON.stringify({ refused: result.code })}`;
    }).join("\n\n");
  }

  /**
   * Runs the attempt to its end: evidence → model (≤2 rounds) → typed actions. Never throws; the result says what
   * happened. `preActions` are deterministic actions the handler already executed this attempt (shown to the model).
   */
  private async runAttempt(input: AgiUnblockInput, preActions: Array<{ action: string; result: string }> = []): Promise<AgiUnblockResult & { attemptId: string }> {
    const d = this.deps;
    const incident = d.executor.incidents.get(input.incidentId);
    const attemptNo = Math.max(1, incident?.attempts ?? 1);
    const attemptId = `agi-model:${input.incidentId.slice(-24)}:${input.stateDigest.slice(-16)}:${attemptNo}`;
    const claim = d.db.transaction(() => {
      const existing = d.db.prepare("SELECT status FROM agi_model_attempts WHERE id=?").get(attemptId);
      if (existing) return "agi.model.attempt-already-ran";
      if (d.db.prepare("SELECT 1 FROM agi_model_attempts WHERE goal_id=? AND status='running' LIMIT 1").get(input.goalId)) return "agi.model.in-flight";
      d.db.prepare("INSERT INTO agi_model_attempts(id,goal_id,incident_id,state_digest,status,created_at_ms) VALUES (?,?,?,?,'running',?)")
        .run(attemptId, input.goalId, input.incidentId, input.stateDigest, d.now());
      return null;
    }).immediate();
    if (claim) return { attemptId, outcome: "rested", code: claim };
    let usageComplete = true;
    const settle = (status: string, code: string, extra: { runtime?: unknown; rounds?: number; input?: number; output?: number; actions?: unknown[] } = {}) => {
      d.db.prepare(`UPDATE agi_model_attempts SET status=?, code=?, runtime_json=?, rounds=?, input_tokens=?, output_tokens=?, actions_json=?, settled_at_ms=?
        WHERE id=?`).run(status, code, extra.runtime ? JSON.stringify(extra.runtime) : null, extra.rounds ?? 0,
        usageComplete ? extra.input ?? null : null, usageComplete ? extra.output ?? null : null,
        JSON.stringify(extra.actions ?? []), d.now(), attemptId);
    };
    const controlRefusal = () => agiDecisionRefusal(input);
    const refreshFence = () => {
      if (controlRefusal()) return null;
      try { return input.refreshFence ? input.refreshFence() : { goalId: input.goalId, runId: input.runId ?? "", runVersion: input.runVersion ?? -1 }; }
      catch { return null; }
    };
    const initialRefusal = controlRefusal();
    if (initialRefusal) { settle("refused", initialRefusal); return { attemptId, outcome: "rested", code: initialRefusal }; }
    let decisionSignal: AbortSignal;
    try { decisionSignal = agiDecisionAbortSignal(input); }
    catch { settle("refused", AGI_DECISION_CONTROL_CHANGED); return { attemptId, outcome: "rested", code: AGI_DECISION_CONTROL_CHANGED }; }
    // Custody predates evidence, candidate selection and every model round.
    // Failure remains unavailable; apply may never replace this with a fresh capture.
    const episodeCaptureId = `${attemptId}:rest`;
    try { d.executor.captureEpisode(episodeCaptureId, input.goalId); } catch { /* typed unavailable at apply */ }
    const limits = readAgiTokenLimits(d.db);
    const facts = {
      goalId: input.goalId, stateDigest: input.stateDigest, diagnosis: {
        primarySignal: input.diagnosis.primarySignal, causeKind: input.diagnosis.causeKind, ownerClass: input.diagnosis.ownerClass,
        boundary: input.diagnosis.boundary, reasonCode: input.diagnosis.reasonCode, defects: input.diagnosis.defects.map((x) => x.code),
        hostSuggestedPaths: input.diagnosis.altPaths, eligibleTactics: input.diagnosis.eligibleTactics, branchReadiness: input.diagnosis.branchReadiness ?? [], evidenceRefs: input.diagnosis.evidenceRefs },
      alreadyDoneThisAttempt: preActions, installedToolPaths: d.installedPaths().slice(0, 40),
      budget: { attemptTokenLimit: limits.attemptTokenLimit },
    };
    let tokensUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const evidence = this.evidenceBlock(input.goalId, agiEvidenceReads(input), controlRefusal);
    // Plan text the owner sees in the goal panel (replan_tree split descriptions, ask text) follows the app locale.
    const ownerLanguage = currentUiLocale() === "ko" ? "Korean" : "English";
    let userPrompt = `## Blocker (host facts)\n${JSON.stringify(facts)}\n\n## Evidence (P2 read tools, capped and redacted)\n${evidence}`
      + `\n\nOwner-visible text you write (replan_tree descriptions, ask_owner_once ask, dispatch brief) is in ${ownerLanguage}; ids, actions and codes stay English.`
      + "\n\nRound 1 of 2.";
    const candidates = await Promise.resolve().then(() => controlRefusal() ? [] : d.candidates(input.goalId)).catch(() => [] as AgiModelCandidate[]);
    const candidateRefusal = controlRefusal();
    if (candidateRefusal) { settle("refused", candidateRefusal); return { attemptId, outcome: "rested", code: candidateRefusal }; }
    if (!candidates.length) { settle("refused", "agi.model.no-runtime"); return { attemptId, outcome: "failed", code: "agi.model.no-runtime" }; }
    let decision: Decision | null = null;
    let used: AgiModelCandidate | null = null;
    let rounds = 0;
    for (let round = 1; round <= 2; round += 1) {
      if (!refreshFence()) {
        const code = controlRefusal() ?? "agi.action.state-changed";
        settle("refused", code, { rounds, input: inputTokens, output: outputTokens });
        return { attemptId, outcome: "rested", code, tokens: tokensUsed };
      }
      const estimate = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userPrompt) + AGI_MODEL_OUTPUT_TOKENS;
      const refusal = admitAgiTokens(d.db, { goalId: input.goalId, nowMs: d.now(), attemptTokensSoFar: tokensUsed, estimate });
      if (refusal) {
        settle("refused", refusal, { rounds, input: inputTokens, output: outputTokens });
        return { attemptId, outcome: "failed", code: refusal, tokens: tokensUsed };
      }
      const answer = await this.call(round === 1 ? candidates : [used!], userPrompt, controlRefusal, decisionSignal);
      rounds = round;
      if (answer.usage) {
        inputTokens += answer.usage.inputTokens; outputTokens += answer.usage.outputTokens;
        const spent = answer.usage.inputTokens + answer.usage.outputTokens;
        tokensUsed += spent;
        chargeAgiTokens(d.db, input.goalId, spent, d.now());
      } else if (answer.started) {
        usageComplete = false;
        // A provider call that reported no usage is charged at the admission estimate (never zero on a started call).
        tokensUsed += estimate;
        chargeAgiTokens(d.db, input.goalId, estimate, d.now());
      }
      const answerRefusal = controlRefusal();
      if (answerRefusal) {
        settle("refused", answerRefusal, { runtime: answer.candidate?.selection, rounds, input: inputTokens, output: outputTokens });
        return { attemptId, outcome: "rested", code: answerRefusal, tokens: tokensUsed };
      }
      if (!answer.text || !answer.candidate) {
        settle("failed", answer.code ?? "agi.model.no-answer", { rounds, input: inputTokens, output: outputTokens });
        return { attemptId, outcome: "failed", code: answer.code ?? "agi.model.no-answer", tokens: tokensUsed };
      }
      used = answer.candidate;
      decision = parseAgiDecision(answer.text);
      if (!decision) {
        settle("failed", "agi.model.answer-invalid", { runtime: used.selection, rounds, input: inputTokens, output: outputTokens });
        return { attemptId, outcome: "failed", code: "agi.model.answer-invalid", tokens: tokensUsed };
      }
      if (round === 1 && decision.reads.length && !decision.actions.length) {
        const readRefusal = controlRefusal();
        if (readRefusal) {
          settle("refused", readRefusal, { runtime: used.selection, rounds, input: inputTokens, output: outputTokens });
          return { attemptId, outcome: "rested", code: readRefusal, tokens: tokensUsed };
        }
        userPrompt += `\n\n## Your extra reads\n${this.evidenceBlock(input.goalId, decision.reads, controlRefusal)}\n\nRound 2 of 2: answer with actions now; "reads" must be empty.`;
        continue;
      }
      break;
    }
    // Execute in host order with the fence refreshed after each of this attempt's own accepted effects.
    const proposed = decision?.actions ?? [];
    const strategyBatch = proposed.length === 2 && proposed.filter(a => a.action === "rest").length === 1
      && proposed.filter(a => a.action === "replan_tree").length === 1;
    const mixedRest = proposed.some(action => action.action === "rest") && proposed.length > 1;
    const ordered = [...(mixedRest ? proposed.filter(action => action.action === "rest").slice(0, 1) : proposed)].sort((a, b) => EXECUTION_ORDER.indexOf(a.action) - EXECUTION_ORDER.indexOf(b.action));
    let fence = { goalId: input.goalId, runId: input.runId ?? "", runVersion: input.runVersion ?? -1 };
    const receipts: AgiActionReceipt[] = [];
    if (strategyBatch) {
      const refreshed = refreshFence();
      if (!refreshed) receipts.push({ actionId: `${attemptId}:strategy`, action: "rest", ok: false, code: controlRefusal() ?? "agi.action.state-changed" });
      else {
        const request = (action: "replan_tree" | "rest", index: number): import("./actions").AgiActionRequest => ({
          schema: AGI_ACTION_SCHEMA, actionId: `${attemptId}:${index}:${action}`, incidentId: input.incidentId, attempt: attemptNo,
          fence: refreshed, action, args: proposed.find(a => a.action === action)!.args, attemptTokensSoFar: tokensUsed, episodeCaptureId });
        receipts.push(...await d.executor.executeStrategyEpisode({ plan: request("replan_tree",0), rest: request("rest",1) }));
      }
    } else ordered.forEach((entry, index) => {
      {
        const refreshed = refreshFence();
        if (!refreshed) {
          receipts.push({ actionId: `${attemptId}:${index}:${entry.action}`, action: entry.action, ok: false, code: controlRefusal() ?? "agi.action.state-changed" });
          return;
        }
        fence = refreshed;
      }
      const receipt = d.executor.execute({ schema: AGI_ACTION_SCHEMA, actionId: `${attemptId}:${index}:${entry.action}`, incidentId: input.incidentId,
        attempt: attemptNo, fence, action: entry.action, args: entry.args, attemptTokensSoFar: tokensUsed,
        episodeCaptureId, ...(mixedRest ? { episodeRefusal: "goal_episode_mixed_batch" } : {}) });
      receipts.push(receipt);
      if (receipt.ok && !input.refreshFence) {
        const version = d.executor.currentVersion(input.goalId);
        if (version !== null) fence = { ...fence, runVersion: version };
      }
    });
    if (decision?.reflection) {
      d.executor.incidents.reflect(input.incidentId, { atMs: d.now(), action: "rest", result: `model:${decision.reflection.slice(0, 200)}`,
        evidenceRefs: [attemptId], ruledOut: false });
    }
    const actions = receipts.map((receipt) => ({ action: receipt.action, result: receipt.ok ? receipt.code : `refused:${receipt.code}` }));
    const registeredWait = receipts.some(receipt => receipt.action === "rest" && receipt.ok
      && receipt.code === "goal_episode_wait_registered" && receipt.detail?.status === "wait_registered"
      && typeof receipt.detail.waitId === "string" && receipt.detail.waitId.length > 0
      && typeof receipt.detail.checkpointId === "string" && receipt.detail.checkpointId.length > 0);
    const acted = receipts.some((receipt) => receipt.ok && !AGI_NON_ALTERNATIVE_ACTIONS.has(receipt.action as AgiActionKind));
    const asked = receipts.some((receipt) => receipt.ok && receipt.action === "ask_owner_once");
    // Revocation denies successors, not the truth of an already accepted result.
    // Keep completed receipts/accounting even when Stop arrives during an action await.
    const finalRefusal = receipts.some(receipt => receipt.ok) ? null : controlRefusal();
    settle(finalRefusal ? "refused" : "completed", finalRefusal ?? (registeredWait ? "agi.model.wait-registered" : "agi.model.completed"),
      { runtime: used?.selection, rounds, input: inputTokens, output: outputTokens, actions });
    return { attemptId, outcome: registeredWait ? "rested" : acted ? "acted" : asked ? "needs-human" : "rested", code: finalRefusal ?? (registeredWait ? "agi.model.wait-registered" : acted ? "agi.model.acted" : asked ? "agi.model.asked" : "agi.model.rested"),
      actions, tokens: tokensUsed };
  }

  private async call(candidates: AgiModelCandidate[], userPrompt: string, controlRefusal: () => string | null, decisionSignal: AbortSignal): Promise<{ text: string | null; usage: { inputTokens: number; outputTokens: number } | null;
    candidate: AgiModelCandidate | null; started: boolean; code?: string }> {
    let lastCode = "agi.model.runner-unavailable";
    const candidateUsage = createObservedUsageAccumulator();
    let started = false;
    for (const candidate of candidates) {
      const refusal = controlRefusal();
      if (refusal) return { text: null, usage: candidateUsage.total() ?? null, candidate: null, started, code: refusal };
      const picked = this.deps.pickRunner(candidate.status);
      if (!picked) { lastCode = "agi.model.runner-unavailable"; continue; }
      const controller = new AbortController();
      const abortDecision = () => controller.abort(decisionSignal.reason);
      decisionSignal.addEventListener("abort", abortDecision, { once: true });
      if (decisionSignal.aborted) abortDecision();
      const timer = setTimeout(() => controller.abort(new Error("agi-model-timeout")), this.deps.timeoutMs ?? AGI_MODEL_TIME_LIMIT_MS);
      timer.unref?.();
      const usage = createRuntimeUsageCollector();
      let nativeEvidence = false;
      let settled = false;
      let recorded = false;
      let dispatched = false;
      const recordUsage = (returnedUsage?: Parameters<typeof usage.total>[0]): void => {
        if (recorded) return;
        recorded = true;
        started = true;
        candidateUsage.record(usage.total(returnedUsage));
      };
      try {
        const beforeDispatchRefusal = controlRefusal();
        if (beforeDispatchRefusal) return { text: null, usage: candidateUsage.total() ?? null, candidate, started, code: beforeDispatchRefusal };
        dispatched = true;
        const result = await picked.runner({
          systemPrompt: SYSTEM_PROMPT, history: [], userPrompt, backendLabel: picked.label, runtimeSource: candidate.status.source,
          model: candidate.selection.model, effort: "medium", longContext: false, permission: "read", untrustedNoTools: true, judgmentOnly: true,
          surfaceGate: "exclude", maxOutputTokens: AGI_MODEL_OUTPUT_TOKENS,
          outputSchema: { name: "agentlas_agi_unblock_decision_v1", schema: AGI_DECISION_JSON_SCHEMA },
          signal: controller.signal, locale: "en",
          ...(candidate.status.kind === "codex" ? { isolatedMcpConfig: true as const } : {}),
        }, {
          onPartial: (text) => { if (!settled && text) nativeEvidence = true; }, onStatus: () => {},
          onTool: () => { if (!settled) nativeEvidence = true; },
          onRuntimeAttemptStarted: (id) => { if (!settled) { nativeEvidence = true; usage.start(id); } },
          onTerminalObservedUsage: (observed, id) => { if (!settled) { nativeEvidence = true; usage.recordTerminal(observed, id); } },
        });
        settled = true;
        const observed = usage.total(result.observedUsage);
        recordUsage(result.observedUsage);
        const refusal = controlRefusal();
        if (refusal) return { text: null, usage: candidateUsage.total() ?? null, candidate, started, code: refusal };
        if (controller.signal.aborted) {
          return { text: null, usage: candidateUsage.total() ?? null, candidate, started: true, code: "agi.model.timeout" };
        }
        if (result.failure) {
          this.deps.noteFailure?.(candidate.status, result.failure);
          lastCode = `agi.model.runtime-${result.failure.kind}`;
          if (NEXT_CANDIDATE_FAILURES.has(result.failure.kind) && !observed) continue;
          return { text: null, usage: candidateUsage.total() ?? null, candidate, started: true, code: lastCode };
        }
        return { text: result.text ?? "", usage: candidateUsage.total() ?? null, candidate, started: true };
      } catch (error) {
        settled = true;
        const refusal = controlRefusal();
        if (refusal) {
          if (dispatched) recordUsage();
          return { text: null, usage: candidateUsage.total() ?? null, candidate, started, code: refusal };
        }
        const aborted = controller.signal.aborted;
        lastCode = aborted ? "agi.model.timeout" : "agi.model.runner-threw";
        if (!aborted && !nativeEvidence && isJudgmentRefusal(error)) continue;
        recordUsage();
        return { text: null, usage: candidateUsage.total() ?? null, candidate, started: true, code: lastCode };
      } finally {
        clearTimeout(timer);
        decisionSignal.removeEventListener("abort", abortDecision);
      }
    }
    return { text: null, usage: candidateUsage.total() ?? null, candidate: null, started, code: lastCode };
  }
}
