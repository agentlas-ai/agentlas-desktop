import type { InvocationRunReceipt, RunEventUi } from "@shared/types";
import { projectOneActivityFromLedger, type OneActivityArtifact } from "./one-activity";

/**
 * The outputs a split-view pane lists for its chat: exactly what the full One view's Outputs panel lists for that chat.
 *
 * The full view restores a chat's Activity from its latest run alone (OneShell: invoke.latestReceipt -> runLedger.events(run, 500)
 * -> projectOneActivityFromLedger(events, receipt) -> activity.artifacts -> TaskSidePanel items), and a run that starts resets it to
 * that run (beginOneActivityState: "the Activity speaks for that one run"). Inside the run the reducer merges every later save of
 * the same output into one entry that opens the newest bytes (mergeVerifiedSurfaceArtifacts, key = shared/one-artifacts.ts
 * oneArtifactRailMergeKey: kind, Task, chat, label). The pane projects with the same function over the same rows.
 *
 * The pane used to join the events of the chat's last four runs and project them as ONE run. The reducer seals at the first
 * terminal event of that joined stream, so only the oldest of the four runs could ever contribute: a run that finished
 * without a file followed by a run that wrote one showed no output at all, each of the two alone showed it, and the pane's
 * Outputs button never carried a count.
 *
 * `runs` is the `runLedger.chatTimeline` answer, oldest first; the newest run is the last entry (the pane asks for that one
 * run). Anything that is not that answer, a run without events, or a projection that cannot be read lists nothing.
 */
export function projectLatestRunArtifacts(runs: unknown): OneActivityArtifact[] {
  if (!Array.isArray(runs) || runs.length === 0) return [];
  const latest = runs[runs.length - 1] as { receipt?: InvocationRunReceipt | null; events?: unknown } | null;
  const events = latest && Array.isArray(latest.events) ? (latest.events as RunEventUi[]) : [];
  if (events.length === 0) return [];
  try {
    return projectOneActivityFromLedger(events, latest?.receipt ?? null).artifacts;
  } catch {
    return [];
  }
}
