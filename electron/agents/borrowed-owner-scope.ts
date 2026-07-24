import { createHash } from "node:crypto";
import { getAuthenticatedActorIds } from "../auth";

export const DEVICE_LOCAL_BORROWED_OWNER_SCOPE = "borrowed-owner:device-local";

/**
 * Main-only opaque owner partition. Raw Hub user/workspace IDs never enter the
 * Desktop database, filesystem, IPC, logs, or renderer.
 */
export function activeBorrowedOwnerScopeKey(): string {
  const actor = getAuthenticatedActorIds();
  if (!actor) return DEVICE_LOCAL_BORROWED_OWNER_SCOPE;
  const digest = createHash("sha256")
    .update("agentlas:borrowed-agent-career-owner:v1\0")
    .update(actor.workspaceId)
    .update("\0")
    .update(actor.userId)
    .digest("hex");
  return `borrowed-owner:account:${digest}`;
}

export function borrowedOwnerPartitionDirectory(ownerScopeKey: string): string {
  const digest = createHash("sha256")
    .update("agentlas:borrowed-agent-career-directory:v1\0")
    .update(ownerScopeKey)
    .digest("hex");
  return `owner-${digest}`;
}

export function borrowedProfileId(
  ownerScopeKey: string,
  entityKind: "agent" | "team",
  agentDefinitionId: string,
  agentReleaseId: string,
  componentId = "",
): string {
  const digest = createHash("sha256")
    .update("agentlas:borrowed-agent-profile:v2\0")
    .update(ownerScopeKey)
    .update("\0")
    .update(entityKind)
    .update("\0")
    .update(agentDefinitionId)
    .update("\0")
    .update(agentReleaseId)
    .update("\0")
    .update(componentId)
    .digest("hex");
  return `borrowed-profile:${digest}`;
}

/** Opaque filesystem/curator key derived from an immutable Hub release tuple. */
export function borrowedMemoryKey(
  agentDefinitionId: string,
  agentReleaseId: string,
  componentId = "",
): string {
  const digest = createHash("sha256")
    .update("agentlas:borrowed-agent-memory:v2\0")
    .update(agentDefinitionId)
    .update("\0")
    .update(agentReleaseId)
    .update("\0")
    .update(componentId)
    .digest("hex");
  return `asset-${digest}`;
}
