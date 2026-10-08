import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { userDataPath } from "../runtime-paths";

export function agentWorkspaceStorePath(agentId: string): string {
  return userDataPath("agent-workspaces", createHash("sha256").update(agentId).digest("hex"));
}
/** A partial file transaction must never become a new run's instructions. */
export function assertAgentWorkspaceActivationReady(agentId: string): void {
  const journal = path.join(agentWorkspaceStorePath(agentId), "operation.json");
  if (fs.existsSync(journal)) {
    const error = new Error("Review and recover this agent's unfinished file change before starting another run.") as Error & { code: string };
    error.code = "agent_revision_recovery_required";
    throw error;
  }
}
