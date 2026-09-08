export type ShellExecutionOutcome = "failed" | "succeeded" | "response" | "cancelled";

export interface ShellExecutionEvidence {
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  output?: string;
}

/**
 * A response body proves only that the tool returned something. It is not a
 * process-success signal. Keep unknown exits neutral and use only typed state.
 */
export function shellExecutionOutcome(evidence: ShellExecutionEvidence): ShellExecutionOutcome {
  if (evidence.status === "failed" || (evidence.exitCode != null && evidence.exitCode !== 0)) return "failed";
  if (evidence.status === "cancelled") return "cancelled";
  if (evidence.exitCode === 0) return "succeeded";
  return "response";
}
