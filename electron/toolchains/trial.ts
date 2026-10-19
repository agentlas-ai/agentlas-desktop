// Trial use: a detector-made Toolchain draft earns callability by working in real tasks, not by a staged test.
//
// The host promotes a generated draft after successful uses in real tasks. The existing tool interface carries
// the trial without adding working-agent instructions. Concretely:
//  · search — when nothing callable matches, at most one matching detector draft is returned with stage "trial";
//    one chance per conversation per day, so a draft that does not fit never keeps coming back;
//  · run — toolchain_run accepts that exact draft version only for a conversation the search granted it to;
//  · verdict (host, no model) — two successful real uses on separate days or conversations promote it with those
//    receipts as its validation; two failed or uncertain uses retire it from trials and queue a repair request.
// An effectful draft (upload, post) is never run for testing: its trial is the effect the task was already going to
// make, and a success needs the declared output contract (for example the public URL) to pass.

import { getDb } from "../store/db";
import type { ToolchainAsset, ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { TRIAL_GRANT_WINDOW_MS, trialEligible, trialVerdict, trialVersion, type TrialLedger } from "../../shared/toolchain-detector";

export type { TrialLedger } from "../../shared/toolchain-detector";
import { getToolchainAsset, promoteToolchainVersionFromTrial } from "./assets";
import { rankToolchainAssetCandidates } from "./search";

const TRIAL = "toolchain.trial.v1:";
const AUTHORED = "toolchain.detector.verdict.v1:";

const key = (id: string, version: number) => `${TRIAL}${id}@${version}`;
function read(id: string, version: number): TrialLedger | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key(id, version)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as TrialLedger : null; } catch { return null; }
}
function write(ledger: TrialLedger): void {
  getDb().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key(ledger.toolchainId, ledger.version),
    JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }));
}

/** Draft ids the repeated-work detector authored (its verdict rows); owner-made drafts keep the owner's own flow. */
function detectorAuthored(): Set<string> {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(AUTHORED, `${AUTHORED}￿`) as Array<{ value: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    try { const verdict = JSON.parse(row.value) as { generation?: { toolchainId?: string } | null }; if (verdict.generation?.toolchainId) ids.add(verdict.generation.toolchainId); }
    catch { /* a corrupt verdict authors nothing */ }
  }
  return ids;
}

/** Called by toolchain_search only when nothing callable matched. Returns the granted draft, or null. Never throws. */
export function grantToolchainTrial(task: string, chatId: string | null, assets: ToolchainAsset[], now = Date.now()): { asset: ToolchainAsset; version: number } | null {
  try {
    if (!chatId || !task.trim()) return null;
    const authored = detectorAuthored();
    const candidates = assets.flatMap(asset => {
      const release = authored.has(asset.id) ? trialVersion(asset) : null;
      return release && trialEligible(asset, read(asset.id, release.version), chatId, now) ? [{ id: asset.id, release }] : [];
    });
    const [hit] = rankToolchainAssetCandidates(task, candidates, 1);
    if (!hit) return null;
    const asset = assets.find(item => item.id === hit.id)!;
    const prior = read(asset.id, hit.release.version);
    write({ schema: "agentlas.toolchain-trial.v1", toolchainId: asset.id, version: hit.release.version, contentHash: hit.release.contentHash,
      state: "trial", grants: [...(prior?.grants ?? []).slice(-50), { chatId, at: new Date(now).toISOString() }], outcomes: prior?.outcomes ?? [],
      updatedAt: new Date(now).toISOString() });
    return { asset, version: hit.release.version };
  } catch (error) {
    console.warn("[toolchain-trial] grant skipped:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** toolchain_run may execute this draft version for this conversation: a live grant from its own search. */
export function toolchainTrialGranted(chatId: string | null, toolchainId: string, version: number, now = Date.now()): boolean {
  if (!chatId) return false;
  const ledger = read(toolchainId, version), asset = getToolchainAsset(toolchainId);
  const release = asset ? trialVersion(asset) : null;
  return Boolean(ledger && ledger.state === "trial" && release && release.version === version && release.contentHash === ledger.contentHash
    && ledger.grants.some(grant => grant.chatId === chatId && now - Date.parse(grant.at) < TRIAL_GRANT_WINDOW_MS));
}

/** Median input+output tokens of whole runs, from runtime_usage_recorded. Whole-run numbers include the surrounding
 * task, so this is a comparison signal, not an exact saving. */
function medianRunTokens(runIds: readonly string[]): number | null {
  const totals = runIds.slice(-50).flatMap(runId => {
    const rows = getDb().prepare("SELECT json_extract(payload_json,'$.tokens') AS tokens FROM run_events WHERE run_id=? AND kind='runtime_usage_recorded'")
      .all(runId) as Array<{ tokens: string | null }>;
    let total = 0, seen = false;
    for (const row of rows) {
      try { const t = JSON.parse(row.tokens ?? "null") as { inputTokens?: number; outputTokens?: number } | null;
        if (t) { total += (t.inputTokens ?? 0) + (t.outputTokens ?? 0); seen = true; } } catch { /* unreadable usage row */ }
    }
    return seen ? [total] : [];
  }).sort((a, b) => a - b);
  return totals.length ? totals[Math.floor(totals.length / 2)] : null;
}

/** Hand-done runs of the detected signal vs runs that used this Toolchain. */
export function toolchainTokenComparison(toolchainId: string, useRunIds: readonly string[]) {
  const baseline = new Set<string>();
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(AUTHORED, `${AUTHORED}\uffff`) as Array<{ value: string }>;
  for (const row of rows) {
    try { const v = JSON.parse(row.value) as { generation?: { toolchainId?: string } | null; memberRunIds?: string[] };
      if (v.generation?.toolchainId === toolchainId) for (const id of v.memberRunIds ?? []) baseline.add(id); } catch { /* skip */ }
  }
  return { baselineRuns: baseline.size, baselineMedianTokens: medianRunTokens([...baseline]),
    toolchainRuns: useRunIds.length, toolchainMedianTokens: medianRunTokens(useRunIds) };
}

/** Called by the call executor with every terminal receipt; ignores calls that are not trials. Never throws. */
export function recordToolchainTrialOutcome(receipt: Readonly<ToolchainCallReceipt>): void {
  try {
    if (receipt.status === "running" || receipt.dryRun) return;
    const ledger = read(receipt.toolchainId, receipt.version);
    if (!ledger || ledger.state !== "trial" || ledger.contentHash !== receipt.contentHash || ledger.outcomes.some(item => item.callId === receipt.id)) return;
    const outcomes = [...ledger.outcomes, { callId: receipt.id, chatId: receipt.callerChatId, parentRunId: receipt.parentRunId,
      status: receipt.status, error: receipt.error ?? null, at: receipt.completedAt ?? new Date().toISOString() }];
    const verdict = trialVerdict(outcomes);
    if (verdict === "promote") {
      const successes = outcomes.filter(outcome => outcome.status === "succeeded");
      promoteToolchainVersionFromTrial(receipt.toolchainId, receipt.version, receipt.contentHash,
        successes.map(outcome => outcome.callId), successes.at(-1)!.chatId);
      const tokens = toolchainTokenComparison(receipt.toolchainId, successes.flatMap(outcome => outcome.parentRunId ? [outcome.parentRunId] : []));
      console.info(`[toolchain-trial] promoted ${receipt.toolchainId}@${receipt.version} after ${successes.length} real uses; run tokens ${JSON.stringify(tokens)}`);
      write({ ...ledger, outcomes, state: "promoted", tokens });
      return;
    } else if (verdict === "retire") console.info(`[toolchain-trial] retired ${receipt.toolchainId}@${receipt.version}: ${outcomes.map(o => o.error ?? o.status).join("; ").slice(0, 300)}`);
    write({ ...ledger, outcomes, state: verdict === "retire" ? "retired" : "trial" });
  } catch (error) {
    console.warn("[toolchain-trial] outcome not recorded:", error instanceof Error ? error.message : error);
  }
}

/** Retired trials whose failures the detector should send back to the generalizer as a repair request. */
export function retiredToolchainTrials(): TrialLedger[] {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(TRIAL, `${TRIAL}￿`) as Array<{ value: string }>;
  return rows.flatMap(row => { try { const ledger = JSON.parse(row.value) as TrialLedger; return ledger.state === "retired" ? [ledger] : []; } catch { return []; } });
}

export function markToolchainTrialRepairRequested(toolchainId: string, version: number): void {
  const ledger = read(toolchainId, version);
  if (ledger) write({ ...ledger, repairRequestedAt: new Date().toISOString() });
}
