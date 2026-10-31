import { AUTO_EVOLUTION_POLICY } from "../../shared/agent-learning-policy";
import type { AgentWorkspaceDiff, AgentWorkspaceRevisionComparison } from "../../shared/agent-workspace";
import type { LessonEvidence } from "../../shared/agent-learning-policy";
import { AgentWorkspaceError } from "./workspace-snapshot";
import { AGENT_SKILL_ROOTS } from "./files";
import { agentRevisionOutcomes, compareRevisionOutcomes } from "./revision-outcomes";
import { applyAgentWorkspaceProposal, deferAgentLearnings, editableAgentIds, getAgentWorkspace, getAgentWorkspaceDiff,
  issueAgentWorkspaceApprovalReceipt, learningSourceFacts, prepareAgentWorkspaceRollback, rejectAgentWorkspaceProposal } from "./workspace-service";
import { hasAutoEvolutionRecord, readAutoEvolutionEnabled, readAutoEvolutionLog, writeAutoEvolutionEnabled, writeAutoEvolutionLog,
  type AutoEvolutionEntry } from "./auto-evolution-store";

/**
 * Auto-evolution: the owner's opt-in (one switch per agent) to let the narrowest kind of learning change apply itself, and to
 * have it taken back when the agent's own runs get worse. Everything outside that kind stays a diff the owner reads.
 *
 * Harness² (arXiv 2610.14224) judges a change by re-running the same task and comparing the executions, and says plainly that the
 * signal does not verify correctness. It has no way to judge a design or a taste, and neither do we, so the gate here is
 * structural and host-counted, never a model's opinion of quality:
 *   - the lessons are procedures (kind "procedure"), not preferences, decisions or facts;
 *   - the host recorded at least one failure or owner correction in the runs they came from (a machine observation);
 *   - the change only adds a new on-demand skill and its trigger line: nothing is removed, no script, hook or plugin, no always-on prose.
 * (The compiler already refused to lengthen always-on text and returned "no change" for non-reusable lessons.)
 *
 * After it applies, the change is watched. Runs on the new version are compared with runs on the version it replaced, kind of
 * work by kind of work (revision-outcomes.ts). If any kind with runs on both sides got worse, the change is rolled back and its
 * lessons wait until their content changes. If none got worse for the whole watch window it is kept. No new model call is made
 * anywhere in this module, so no prompt is added (docs/PROMPT-COMPOSITION-POLICY.md).
 */

export type AutoApplyCode =
  | "auto_evolution_off" | "not_review_ready" | "not_a_learning_change" | "evaluation_pending" | "kind_not_procedure"
  | "no_machine_observation" | "outside_skill_scope" | "owner_text_removed" | "needs_a_new_skill" | "always_on_over_limit"
  | "source_unavailable" | "apply_refused";

const SKILL_FILE = new RegExp(`^(?:${AGENT_SKILL_ROOTS.map(root => root.replace(/[.]/g, "\\.")).join("|")})/[^/]+/SKILL\\.md$`);

/** The owner's switch. Written only from the trusted owner IPC. */
export function setAutoEvolution(agentId: string, enabled: boolean): { enabled: boolean } {
  if (typeof enabled !== "boolean") throw new AgentWorkspaceError("invalid_setting", "Choose on or off.");
  if (!getAgentWorkspace(agentId).writable) throw new AgentWorkspaceError("not_writable", "This agent's files cannot be changed here.");
  writeAutoEvolutionEnabled(agentId, enabled);
  return { enabled: readAutoEvolutionEnabled(agentId) };
}
export function autoEvolutionEnabled(agentId: string): boolean { return readAutoEvolutionEnabled(agentId); }

/** Pure: may this learning change apply without the owner reading it? Returns the code of the first rule it fails. */
export function autoApplyDecision(diff: Pick<AgentWorkspaceDiff, "memoryEntryIds" | "changes" | "changeSummary" | "alwaysOn">,
  facts: { kinds: readonly string[]; evidence: Pick<LessonEvidence, "failures" | "ownerCorrections"> }): { ok: true } | { ok: false; code: AutoApplyCode } {
  if (!diff.memoryEntryIds.length) return { ok: false, code: "not_a_learning_change" };
  if (!facts.kinds.length || facts.kinds.some(kind => kind !== "procedure")) return { ok: false, code: "kind_not_procedure" };
  if (facts.evidence.failures + facts.evidence.ownerCorrections < 1) return { ok: false, code: "no_machine_observation" };
  const entry = diff.alwaysOn?.path ?? null;
  if (diff.alwaysOn?.overHard) return { ok: false, code: "always_on_over_limit" };
  let newSkills = 0;
  for (const change of diff.changes) {
    if (change.binary || change.beforeExecutable || change.afterExecutable) return { ok: false, code: "outside_skill_scope" };
    if (change.operation === "create" && SKILL_FILE.test(change.path)) { newSkills += 1; continue; }
    if (change.operation === "modify" && entry && change.path === entry) continue;
    return { ok: false, code: "outside_skill_scope" };
  }
  if (!newSkills) return { ok: false, code: "needs_a_new_skill" };
  // The entry file may only gain lines, at most one trigger line per new skill; the owner's own text is never rewritten here.
  const entrySummary = (diff.changeSummary ?? []).find(line => line.path === entry);
  if (entry && diff.changes.some(change => change.path === entry)) {
    if (!entrySummary) return { ok: false, code: "owner_text_removed" };
    if (entrySummary.removedLines > 0) return { ok: false, code: "owner_text_removed" };
    if (entrySummary.addedLines > newSkills) return { ok: false, code: "outside_skill_scope" };
  }
  return { ok: true };
}

/**
 * Applies a prepared learning change when the owner's switch is on and the gate passes. Never throws: a refusal (a run is
 * active, the files moved) leaves the change as an ordinary review-ready diff for the owner.
 */
export function autoApplyLearningProposal(proposalId: string): { applied: boolean; code?: AutoApplyCode; revisionId?: string } {
  let diff: AgentWorkspaceDiff;
  try { diff = getAgentWorkspaceDiff(proposalId); } catch { return { applied: false, code: "source_unavailable" }; }
  if (!readAutoEvolutionEnabled(diff.agentId)) return { applied: false, code: "auto_evolution_off" };
  if (diff.status !== "review_ready") return { applied: false, code: "not_review_ready" };
  if (readAutoEvolutionLog(diff.agentId).some(entry => entry.state === "watching")) return { applied: false, code: "evaluation_pending" };
  let facts: ReturnType<typeof learningSourceFacts>;
  try { facts = learningSourceFacts(diff.agentId, diff.memoryEntryIds); } catch { return { applied: false, code: "source_unavailable" }; }
  const decision = autoApplyDecision(diff, facts);
  if (!decision.ok) return { applied: false, code: decision.code };
  try {
    const receipt = issueAgentWorkspaceApprovalReceipt(diff.id, diff.reviewedHash);
    const applied = applyAgentWorkspaceProposal({ proposalId: diff.id, reviewedHash: diff.reviewedHash, approvalReceiptId: receipt });
    if (!applied.appliedRevisionId) return { applied: false, code: "apply_refused" };
    const log = readAutoEvolutionLog(diff.agentId);
    log.push({ revisionId: applied.appliedRevisionId, baseRevisionId: applied.baseRevisionId, proposalId: diff.id, memoryEntryIds: diff.memoryEntryIds,
      appliedAt: applied.appliedAt ?? new Date().toISOString(), state: "watching" });
    writeAutoEvolutionLog(diff.agentId, log);
    return { applied: true, revisionId: applied.appliedRevisionId };
  } catch { return { applied: false, code: "apply_refused" }; }
}

const badness = (counts: { runs: number; failed: number; errors: number; steering: number }): number => (counts.failed + counts.errors + counts.steering) / counts.runs;

/**
 * Pure: what the runs say about a change being watched. Rollback needs a kind of work with at least two runs on both sides
 * (one run is not a rate) in which failures, tool errors and owner corrections per run went up. The downside is weighed as
 * heavily as the upside: any such kind is enough, and a rollback is cheap because the replaced version is restored whole.
 * Keeping needs the whole watch window with nothing worse. No comparable kind for the whole window means "unmeasured".
 */
export function autoEvolutionVerdict(comparison: AgentWorkspaceRevisionComparison | null, appliedAt: string, now: Date):
  { verdict: "wait" | "keep" | "keep_unmeasured" | "rollback"; reason: string } {
  const comparable = (comparison?.rows ?? []).filter(row => !row.limit && row.before && row.after);
  const worse = comparable.filter(row => badness(row.after!) > badness(row.before!));
  if (worse.length) return { verdict: "rollback", reason: `worse:${worse.map(row => row.kind).join(",")}` };
  const ageDays = (now.getTime() - Date.parse(appliedAt)) / 86_400_000;
  if (!(ageDays >= AUTO_EVOLUTION_POLICY.watchDays)) return { verdict: "wait", reason: comparable.length ? "no_regression_so_far" : "no_comparable_runs" };
  return comparable.length ? { verdict: "keep", reason: "no_regression_in_window" } : { verdict: "keep_unmeasured", reason: "no_comparable_runs_in_window" };
}

function settle(agentId: string, entry: AutoEvolutionEntry, state: AutoEvolutionEntry["state"], reason: string, now: Date): void {
  const log = readAutoEvolutionLog(agentId);
  const found = log.find(item => item.revisionId === entry.revisionId);
  if (!found) return;
  found.state = state; found.reason = reason; found.evaluatedAt = now.toISOString();
  writeAutoEvolutionLog(agentId, log);
}

/** One agent: settle every change being watched. No model call. Returns what happened, for the log line. */
export function evaluateAutoEvolution(agentId: string, now = new Date()): Array<{ revisionId: string; result: "wait" | "keep" | "keep_unmeasured" | "rolled_back" | "superseded" | "rollback_deferred"; reason: string }> {
  const out: Array<{ revisionId: string; result: "wait" | "keep" | "keep_unmeasured" | "rolled_back" | "superseded" | "rollback_deferred"; reason: string }> = [];
  for (const entry of readAutoEvolutionLog(agentId).filter(item => item.state === "watching")) {
    const snapshot = getAgentWorkspace(agentId);
    // Someone changed the files since (the owner, a sync): the comparison no longer isolates this change, and rolling back
    // to the version before it would also undo their work.
    if (snapshot.currentRevisionId !== entry.revisionId) {
      settle(agentId, entry, "superseded", "files_changed_since", now);
      out.push({ revisionId: entry.revisionId, result: "superseded", reason: "files_changed_since" });
      continue;
    }
    const outcomes = agentRevisionOutcomes(agentId);
    const verdict = autoEvolutionVerdict(compareRevisionOutcomes(entry.baseRevisionId, outcomes.get(entry.baseRevisionId), outcomes.get(entry.revisionId)), entry.appliedAt, now);
    if (verdict.verdict === "wait") { out.push({ revisionId: entry.revisionId, result: "wait", reason: verdict.reason }); continue; }
    if (verdict.verdict === "keep" || verdict.verdict === "keep_unmeasured") {
      settle(agentId, entry, verdict.verdict === "keep" ? "kept" : "kept_unmeasured", verdict.reason, now);
      out.push({ revisionId: entry.revisionId, result: verdict.verdict, reason: verdict.reason });
      continue;
    }
    // Rollback. A run in flight keeps the files fixed, so try again on the next pass instead of leaving a stray diff.
    if (snapshot.activation !== "ready") { out.push({ revisionId: entry.revisionId, result: "rollback_deferred", reason: snapshot.activation }); continue; }
    let proposalId: string | null = null;
    try {
      const proposal = prepareAgentWorkspaceRollback({ agentId, revisionId: entry.baseRevisionId });
      proposalId = proposal.id;
      const diff = getAgentWorkspaceDiff(proposal.id);
      const receipt = issueAgentWorkspaceApprovalReceipt(diff.id, diff.reviewedHash);
      applyAgentWorkspaceProposal({ proposalId: diff.id, reviewedHash: diff.reviewedHash, approvalReceiptId: receipt });
      try { deferAgentLearnings(agentId, entry.memoryEntryIds); } catch { /* The lesson may be proposed again; the next evaluation will catch a repeat. */ }
      settle(agentId, entry, "rolled_back", verdict.reason, now);
      out.push({ revisionId: entry.revisionId, result: "rolled_back", reason: verdict.reason });
    } catch (error) {
      // Never leave a half-prepared rollback in the owner's change list.
      if (proposalId) { try { rejectAgentWorkspaceProposal(proposalId); } catch { /* already settled */ } }
      out.push({ revisionId: entry.revisionId, result: "rollback_deferred", reason: error instanceof AgentWorkspaceError ? error.code : "rollback_failed" });
    }
  }
  return out;
}

/**
 * The background pass (learning-proposer.ts tick, Main only, idle machine): for every agent with an auto-evolution record,
 * settle the changes being watched, then retry applying a learning change that was waiting on a busy run.
 */
export function runAutoEvolutionPass(now = new Date()): Array<{ agentId: string; evaluated: ReturnType<typeof evaluateAutoEvolution>; applied?: string }> {
  const out: Array<{ agentId: string; evaluated: ReturnType<typeof evaluateAutoEvolution>; applied?: string }> = [];
  for (const agentId of editableAgentIds()) {
    if (!hasAutoEvolutionRecord(agentId)) continue;
    try {
      const evaluated = evaluateAutoEvolution(agentId, now);
      let applied: string | undefined;
      if (readAutoEvolutionEnabled(agentId)) {
        const waiting = getAgentWorkspace(agentId).proposals.find(proposal => proposal.status === "review_ready" && proposal.memoryEntryIds.length > 0);
        if (waiting) { const result = autoApplyLearningProposal(waiting.id); if (result.applied) applied = result.revisionId; }
      }
      if (evaluated.length || applied) out.push({ agentId, evaluated, ...(applied ? { applied } : {}) });
    } catch (error) { console.warn("[auto-evolution] agent pass failed:", error instanceof Error ? error.message : error); }
  }
  return out;
}
