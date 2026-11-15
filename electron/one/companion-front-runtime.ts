import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { rolePriorityRuntimes } from "../runtime/selection";

/** The owner's configured orchestrator order, without a return to the already
 * exhausted Agentlas serving lane. Selection is not permission to replay:
 * the caller must separately prove a previous attempt had no effect. */
export function companionFrontOwnLane(runtimes: RuntimeStatus[]): RuntimeSelection[] {
  return rolePriorityRuntimes(runtimes, "orchestrator", {allowLegacyActive:false})
    .filter(runtime => runtime.kind !== "agentlas")
    .map(runtime => ({kind:runtime.kind,backend:runtime.backend,source:runtime.source,acpAgentId:runtime.acpAgentId,
      label:runtime.label,model:runtime.model ?? undefined,effort:runtime.effort ?? undefined,longContext:runtime.longContextEnabled}));
}
