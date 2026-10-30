import type { McpInvocationRequest } from "../../shared/types";
import type { InvocationWorkspaceBinding } from "./workspace-binding";
import { ownerMessageSurface } from "./owner-intake";

/**
 * Why an owner message in this run context gets no Goal review (null: it is reviewed). The start path adds not_local_user_turn.
 *
 * The context is the RUN the direction enters, and a run the owner started from the phone or Telegram carries that channel's
 * workspace binding / execution context. Those are the owner's own channels (owner-intake.ts ownerMessageSurface): a direction
 * typed into such a turn is the owner's word like any other, and the start path already reviews a phone or Telegram turn's own
 * prompt. Skipping them here let a restated target sent while the owner's phone turn ran vanish from the Goal. Science,
 * automations and company work keep their own adapters and stay skipped.
 */
export function ownerDirectionReviewSkip(request: Pick<McpInvocationRequest, "planMode" | "agentAppMode" | "promptOrigin" | "oneTeamReportTurn">,
  workspaceBinding: InvocationWorkspaceBinding | undefined, executionContext: object & { readonly source?: string } | undefined): string | null {
  if (request.planMode) return "plan_mode";
  if (request.agentAppMode) return "agent_app_mode";
  if (!workspaceBinding && !executionContext) return null;
  if (ownerMessageSurface(request, workspaceBinding, executionContext)) return null;
  return workspaceBinding ? "workspace_binding" : "execution_context";
}
