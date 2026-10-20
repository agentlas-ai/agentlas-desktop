import fs from "node:fs";
import path from "node:path";
import { powerMonitor } from "electron";
import { runSlotStats } from "../runtime/run-slots";
import { agentWorkspaceStorePath } from "./workspace-guard";
import { AGENT_LEARNING_POLICY } from "../../shared/agent-learning-policy";
import { hasOpenLearningProposal, learningAgentIds, prepareAgentWorkspaceFromMemory, readyLessonsFor, writeAgentWorkspaceRecord } from "./workspace-service";

/**
 * Prepares a reviewable change for lessons that came back from enough runs, without the owner opening the agent first.
 *
 * Nothing is applied here. The result is a "review ready" proposal the owner reads as a diff and approves or rejects, as when
 * the owner asks for it. The proposer only decides when to ask, never whether the change is good: that stays with the
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

interface ProposerState { day: string; attempts: number; lastCode: string | null }
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
export async function proposeLearningsForAgent(agentId: string, now = new Date()): Promise<{ outcome: "proposed" | "skipped" | "failed"; code?: string; proposalId?: string }> {
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
    return { outcome: "proposed", proposalId: proposal.id };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "proposal_failed";
    try { writeAgentWorkspaceRecord(stateFile(agentId), { day, attempts: attempts + 1, lastCode: code } satisfies ProposerState); } catch { /* The attempt was already counted. */ }
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
