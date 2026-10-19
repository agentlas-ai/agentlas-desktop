









import { buildApprovedOwnerRulesContext, type OneProfile, type OneProfileInvocationScope } from "../../shared/one-profile";

/** Approved principles, then the same approved and one-time memory the owner-facing context carries. */
export function composeMachineTurnOwnerContext(
  profile: OneProfile,
  scope: OneProfileInvocationScope,
  memory: ReadonlyArray<string | null | undefined> = [],
): string {
  return [buildApprovedOwnerRulesContext(profile, scope), ...memory].filter(Boolean).join("\n\n");
}

/** Main-only request field (renderer IPC, Mobile and steer projections never carry it). */
export function mainOneMachineTurnContext(req: object): string {
  const value = (req as { oneMachineTurnContext?: unknown }).oneMachineTurnContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}
