import fs from "node:fs";
import path from "node:path";
import { powerMonitor } from "electron";
import { runSlotStats } from "../runtime/run-slots";
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
 */
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
/** Attempts a day are given back this many times, so a lesson that really is ineligible cannot spend the model all day. */
const MOVED_ON_RETRIES_PER_DAY = 3;
let timer: NodeJS.Timeout | null = null;
let running = false;

function stateFile(agentId: string): string { return path.join(agentWorkspaceStorePath(agentId), "learning-proposer.json"); }
function today(now: Date): string { return now.toISOString().slice(0, 10); }
function readState(agentId: string): ProposerState | null {
  try { const value = JSON.parse(fs.readFileSync(stateFile(agentId), "utf8")) as Partial<ProposerState>; return typeof value.day === "string" && Number.isSafeInteger(value.attempts) ? value as ProposerState : null; }
  catch { return null; }
}
function idleSeconds(): number {
  try { return powerMonitor.getSystemIdleTime(); } catch { return 0; /* Not knowing counts as not idle. */ }
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
    const proposal = await prepareAgentWorkspaceFromMemory({ agentId, memoryEntryIds: memoryIds });
    // Off by default: the call answers "auto_evolution_off" and the change waits for the owner's diff review.
    const auto = autoApplyLearningProposal(proposal.id);
    return { outcome: "proposed", proposalId: proposal.id, ...(auto.applied ? { autoApplied: true } : {}) };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "proposal_failed";
    const movedOn = state?.day === day ? state.movedOn ?? 0 : 0;
    if (MEMORY_MOVED_ON_CODES.has(code) && movedOn < MOVED_ON_RETRIES_PER_DAY) {
      // The memories moved on while the compiler read them. Give the attempt back: the next tick proposes from the current lessons.
      try { writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts, lastCode: code, movedOn: movedOn + 1 } satisfies ProposerState); } catch { /* The attempt stays counted. */ }
      return { outcome: "skipped", code: "memory_moved_on" };
    }
    try { writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts: attempts + 1, lastCode: code, ...(movedOn ? { movedOn } : {}) } satisfies ProposerState); } catch { /* The attempt was already counted. */ }
    // "No change" and "needs more evidence" are normal answers, not failures worth reporting.
    return { outcome: ["semantic_review_deferred", "learning_not_recurring"].includes(code) ? "skipped" : "failed", code };
  }
}

async function tick(): Promise<void> {
  if (running) return;
  if (idleSeconds() < IDLE_REQUIRED_SEC) return;
  const slots = runSlotStats();
  if (slots.inUse > 0 || slots.queued > 0) return;
  running = true;
  try {
    // Host-only work first (no model): settle changes being watched, retry one that waited on a busy run.
    for (const pass of runAutoEvolutionPass()) console.log(`[auto-evolution] ${pass.evaluated.map(item => `${item.result}:${item.reason}`).join(" ")}${pass.applied ? " applied" : ""}`);
    let tried = 0;
    for (const agentId of learningAgentIds()) {
      if (tried >= AGENTS_PER_TICK) break;
      let result: Awaited<ReturnType<typeof proposeLearningsForAgent>>;
      try { result = await proposeLearningsForAgent(agentId); } catch { continue; /* One agent's missing folder must not stop the rest. */ }
      if (result.outcome === "skipped" && ["daily_limit", "review_pending", "no_ready_lesson"].includes(result.code ?? "")) continue;
      tried += 1;
      console.log(`[learning-proposer] ${result.outcome}${result.code ? ` ${result.code}` : ""}`);
      if (idleSeconds() < IDLE_REQUIRED_SEC) break; // The owner came back; stop spending their model slot.
    }
  } finally { running = false; }
}

export function startLearningProposer(): void {
  if (timer) return;
  timer = setInterval(() => { void tick().catch(error => console.warn("[learning-proposer] tick failed:", error instanceof Error ? error.message : error)); }, TICK_MS);
  timer.unref?.();
}
export function stopLearningProposer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
