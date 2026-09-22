import { createHash } from "node:crypto";

/** A verified checkpoint may keep one native session across bounded episodes.
 * The owner is not a permission grant: the caller must revalidate the current
 * checkpoint and settled effect boundary before every successor dispatch. */
export function goalContinuationSessionIdentity(input: {
  chatId: string;
  goalId: string;
  goalRevision: number;
  workspacePath: string;
  runtime: { kind: string; backend: string; source: string; acpAgentId?: string | null;
    model?: string | null };
  permission: "read" | "write" | "full" | null;
  baseSeed: string;
  invocationRunId: string;
}): { ownerId: string; fingerprintSeed: string; reusable: boolean } {
  const model = input.runtime.model?.trim() || null;
  // An observed or configured provider default may be stale by the next
  // dispatch. Only an explicit pinned model proves stable model identity.
  const reusable = model !== null;
  const identity = JSON.stringify({ schemaVersion: "agentlas.goal-session-identity.v1",
    chatId: input.chatId, goalId: input.goalId, goalRevision: input.goalRevision,
    workspacePath: input.workspacePath, kind: input.runtime.kind, backend: input.runtime.backend,
    source: input.runtime.source, acpAgentId: input.runtime.acpAgentId ?? null,
    model, permission: input.permission });
  const ownerId = `goal-continuation:${createHash("sha256").update(identity)
    .update(reusable ? "" : `\0${input.invocationRunId}`).digest("hex")}`;
  return { ownerId, fingerprintSeed: JSON.stringify({ identity, baseSeed: input.baseSeed }), reusable };
}
