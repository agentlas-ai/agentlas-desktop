import fs from "node:fs";
import path from "node:path";
import { powerMonitor } from "electron";
import { runSlotStats } from "../runtime/run-slots";
import { onMemoryWritten } from "../memory/memory-written-signal";
import { createIdleJob, idleSecondsOrAppQuiet, type IdleJob } from "../memory/idle-job";
import { withModelCallScope } from "../runtime/model-call-ledger";
import { agentWorkspaceStorePath } from "./workspace-guard";
import { AGENT_LEARNING_POLICY } from "../../shared/agent-learning-policy";
import { autoApplyLearningProposal, runAutoEvolutionPass } from "./auto-evolution";
import { hasOpenLearningProposal, learningAgentIds, prepareAgentWorkspaceFromMemory, readyLessonsFor, writeAgentWorkspaceRecord } from "./workspace-service";

/**
 * Prepares a reviewable change for lessons that came back from enough runs, without the owner opening the agent first.
 *
 * Nothing is applied here unless the owner switched auto-evolution on for the agent, and then only the narrow kind of change
 * auto-evolution.ts allows (a new on-demand skill from procedure lessons with a host-recorded failure or correction). Otherwise
 * the result is a "review ready" proposal the owner reads as a diff and approves or rejects, as when the owner asks for it. The proposer only decides when to ask, never whether the change is good: that stays with the
 * compiler's judgment (which may answer "no change") and the owner's reading.
 *
 * Cost limits: Main process only, idle machine, free run slots, at most AGENT_LEARNING_POLICY.proposalsPerAgentPerDay
 * attempts per agent per day (an attempt counts even when the compiler answers "no change"), and nothing while a learning
 * change already waits for review.
 *
 * When it runs: a lesson becomes ready when memory is written (it is counted on read, nothing marks it), so a pass is opened
 * by a signal that memory may have changed: curateEvents committed memory in this process (the producer of lessons; the
 * automatic curator ends in it too), a run freed its slot, a chat changed (turns hosted by the background service), or the app
 * started. There is no periodic timer; with no signal nothing runs. Lessons the background service wrote reach this process
 * through the chat change of the turn that wrote them.
 */
/** Spacing between passes while more agents wait than one pass takes (AGENTS_PER_TICK), or after an attempt that is tried again. */
const TICK_MS = 30 * 60 * 1000;
const IDLE_REQUIRED_SEC = 120;
const AGENTS_PER_TICK = 2;
const LESSONS_PER_PROPOSAL = 3;
const MEMORIES_PER_PROPOSAL = 12;

interface ProposerState { day: string; attempts: number; lastCode: string | null; movedOn?: number }
/**
 * The compiler works from a snapshot of the lesson's memories and takes up to 90 s. The dreaming consolidation of the same agent
 * (every 5 minutes while the agent is active) retires those memories into a rule in that time, so the proposal is refused when
 * its sources are re-read ("memory_ineligible" / "memory_changed"): nothing was shown or applied, the lesson is not wrong, and the
 * day's single attempt was spent (owner log 2026-10-29T00:26:27Z dreaming consolidated 3 entries of shorts-metrics-operator, 00:26:30Z
 * "[learning-proposer] failed memory_ineligible"; the agent kept consolidating and tried again only the next day).
 */
const MEMORY_MOVED_ON_CODES: ReadonlySet<string> = new Set(["memory_ineligible", "memory_changed"]);
/**
 * Failures that say nothing about the lesson: no model connected at that moment (compiler_unavailable), the files or the lock
 * moved during generation (base_changed, update_busy), a model timeout or an answer that was not JSON (no code: proposal_failed).
 * They give the attempt back like the memory codes, so one bad moment does not spend the day.
 */
const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set(["compiler_unavailable", "base_changed", "update_busy", "proposal_failed"]);
/** Attempts a day are given back this many times, so a lesson that really is ineligible cannot spend the model all day. */
const GIVE_BACK_RETRIES_PER_DAY = 3;
let job: IdleJob | null = null;
let running = false;
/** A signal arrived since the last pass that looked at every agent. Starts true: the start-up pass. */
let dirty = true;
/** The earliest start of the next pass while agents are left over. */
let notBefore = 0;

function stateFile(agentId: string): string { return path.join(agentWorkspaceStorePath(agentId), "learning-proposer.json"); }
function today(now: Date): string { return now.toISOString().slice(0, 10); }
function readState(agentId: string): ProposerState | null {
  try { const value = JSON.parse(fs.readFileSync(stateFile(agentId), "utf8")) as Partial<ProposerState>; return typeof value.day === "string" && Number.isSafeInteger(value.attempts) ? value as ProposerState : null; }
  catch { return null; }
}
/** When a pass of this process last finished (or the process started): after six hours without one, the app's own quiet counts as idle (idle-job.ts idleSecondsOrAppQuiet; desktop 3, B3). */
let lastPassAt = Date.now();
function idleSeconds(): number {
  let system = 0;
  try { system = powerMonitor.getSystemIdleTime(); } catch { system = 0; /* Not knowing counts as not idle. */ }
  return idleSecondsOrAppQuiet(system, lastPassAt);
}

/** One agent: record the attempt first (a crash must not retry in a loop), then ask the compiler. */
export async function proposeLearningsForAgent(agentId: string, now = new Date()): Promise<{ outcome: "proposed" | "skipped" | "failed"; code?: string; proposalId?: string; autoApplied?: boolean }> {
  const day = today(now), state = readState(agentId);
  const attempts = state?.day === day ? state.attempts : 0;
  if (attempts >= AGENT_LEARNING_POLICY.proposalsPerAgentPerDay) return { outcome: "skipped", code: "daily_limit" };
  if (hasOpenLearningProposal(agentId)) return { outcome: "skipped", code: "review_pending" };
  const lessons = readyLessonsFor(agentId).slice(0, LESSONS_PER_PROPOSAL);
  const memoryIds = lessons.flatMap(lesson => lesson.memoryIds).slice(0, MEMORIES_PER_PROPOSAL);
  if (!memoryIds.length) return { outcome: "skipped", code: "no_ready_lesson" };
  writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts: attempts + 1, lastCode: null } satisfies ProposerState);
  try {
    // The ledger names this call by its own job (it used to be written under whatever scope the waking signal came from: first-run-labels, trial repair 8 R2).
    const proposal = await withModelCallScope({ role: "curator", phase: "learning-proposer" }, () => prepareAgentWorkspaceFromMemory({ agentId, memoryEntryIds: memoryIds }));
    // Off by default: the call answers "auto_evolution_off" and the change waits for the owner's diff review.
    const auto = autoApplyLearningProposal(proposal.id);
    return { outcome: "proposed", proposalId: proposal.id, ...(auto.applied ? { autoApplied: true } : {}) };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "proposal_failed";
    const movedOn = state?.day === day ? state.movedOn ?? 0 : 0;
    const memoryMovedOn = MEMORY_MOVED_ON_CODES.has(code);
    if ((memoryMovedOn || TRANSIENT_FAILURE_CODES.has(code)) && movedOn < GIVE_BACK_RETRIES_PER_DAY) {
      // The memories moved on, or the attempt failed for a reason unrelated to the lesson. Give the attempt back: the next tick proposes from the current lessons.
      try { writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts, lastCode: code, movedOn: movedOn + 1 } satisfies ProposerState); } catch { /* The attempt stays counted. */ }
      return { outcome: "skipped", code: memoryMovedOn ? "memory_moved_on" : "attempt_given_back" };
    }
    try { writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts: attempts + 1, lastCode: code, ...(movedOn ? { movedOn } : {}) } satisfies ProposerState); } catch { /* The attempt was already counted. */ }
    // "No change" and "needs more evidence" are normal answers, not failures worth reporting.
    return { outcome: ["semantic_review_deferred", "learning_not_recurring", "learning_stays_memory", "skill_format"].includes(code) ? "skipped" : "failed", code };
  }
}

/**
 * One pass over the agents, if the machine is idle and no run is active. True when it looked at them (what is left is in
 * `dirty` and `notBefore`), false when it could not start.
 */
export async function runLearningProposerPass(): Promise<boolean> {
  if (running) return false;
  if (idleSeconds() < IDLE_REQUIRED_SEC) return false;
  const slots = runSlotStats();
  if (slots.inUse > 0 || slots.queued > 0) return false;
  running = true;
  // Signals from here on belong to the next pass.
  dirty = false;
  let leftOver = false;
  try {
    // Host-only work first (no model): settle changes being watched, retry one that waited on a busy run.
    for (const pass of runAutoEvolutionPass()) console.log(`[auto-evolution] ${pass.evaluated.map(item => `${item.result}:${item.reason}`).join(" ")}${pass.applied ? " applied" : ""}`);
    let tried = 0;
    for (const agentId of learningAgentIds()) {
      if (tried >= AGENTS_PER_TICK) { leftOver = true; break; }
      let result: Awaited<ReturnType<typeof proposeLearningsForAgent>>;
      try { result = await proposeLearningsForAgent(agentId); } catch { continue; /* One agent's missing folder must not stop the rest. */ }
      if (result.outcome === "skipped" && ["daily_limit", "review_pending", "no_ready_lesson"].includes(result.code ?? "")) continue;
      tried += 1;
      console.log(`[learning-proposer] ${result.outcome}${result.code ? ` ${result.code}` : ""}`);
      // An attempt that was given back is tried again from the current lessons, a bounded number of times a day (proposeLearningsForAgent).
      if (result.outcome === "skipped" && (result.code === "memory_moved_on" || result.code === "attempt_given_back")) leftOver = true;
      if (idleSeconds() < IDLE_REQUIRED_SEC) { leftOver = true; break; } // The owner came back; stop spending their model slot.
    }
  } catch (error) {
    // The pass did not finish: keep the signal and let the job retry on its bounded ladder.
    dirty = true;
    console.warn("[learning-proposer] pass failed:", error instanceof Error ? error.message : error);
    throw error;
  } finally { running = false; }
  lastPassAt = Date.now();
  if (leftOver) { dirty = true; notBefore = Date.now() + TICK_MS; }
  return true;
}

export function startLearningProposer(): void {
  if (job) return;
  lastPassAt = Date.now(); // the six hours of "no pass" are counted from the proposer's start or its last pass
  dirty = true;
  notBefore = 0;
  job = createIdleJob({
    // Nothing is read here: with no signal since the last full pass there is nothing to do and no timer.
    due: () => dirty ? (notBefore > Date.now() ? notBefore : 0) : null,
    waitMs: () => { const idle = idleSeconds(); return idle < IDLE_REQUIRED_SEC ? Math.max(1_000, (IDLE_REQUIRED_SEC - idle) * 1_000) : 0; },
    pass: runLearningProposerPass,
    // Each signal marks the agents as worth one more look.
    signals: [onMemoryWritten],
    onSignal: () => { dirty = true; },
  });
  job.start(TICK_MS);
}
export function stopLearningProposer(): void {
  job?.stop();
  job = null;
}
