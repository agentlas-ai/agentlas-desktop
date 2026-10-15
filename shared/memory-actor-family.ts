import { BUILTIN_ONE_AGENT_ID } from "./builtin-agent-ids";

/** Product-declared compatibility only. This is neither a runtime actor
 * rewrite nor a capability: owner, project and visibility checks still apply.
 * Keep the portable Core declaration in memory_actor_family.py identical.
 */
export const MEMORY_ACTOR_FAMILY_SCHEMA = "agentlas.memory-actor-family.v1";
export const CORE_ONE_ACTOR_ID = "agentlas-one";
export const ONE_MEMORY_ACTOR_IDS: readonly string[] = Object.freeze([BUILTIN_ONE_AGENT_ID, CORE_ONE_ACTOR_ID]);

export function isOneMemoryActor(actor: string | null | undefined): boolean {
  return typeof actor === "string" && ONE_MEMORY_ACTOR_IDS.includes(actor);
}

export function memoryActorIds(actor: string | null): readonly (string | null)[] {
  return isOneMemoryActor(actor) ? ONE_MEMORY_ACTOR_IDS : [actor];
}

export function sameMemoryActor(left: string | null | undefined, right: string | null | undefined): boolean {
  return left === right || (isOneMemoryActor(left) && isOneMemoryActor(right));
}
