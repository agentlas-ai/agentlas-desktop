// The owner context Main hands one invocation is split by who reads a turn's output (typed, never by text matching).
//
// oneProfileContext — the reply the owner reads (One's answer, a Taskforce synthesis, a firm CEO's own answer): One's
// persona, identity and voice. They decide how that reply ends ("end with one next action", the owner's own
// progress-bar line), a duty only that reply can honor.
// oneMachineTurnContext — a turn whose output the host parses (a teammate's typed handoff, a typed plan, a swarm worker
// result, every turn of a team that holds one worker seat): the owner's substance only, the approved operating
// principles and the approved and one-time memory. Production 2026-10-16 (Yotube room 5d37e4cc, independent review,
// codex gpt-6.1-sol): with no legal place for its closing lines inside the JSON handoff, the teammate kept writing them
// in its last open string, "다음 행동은 …" / "다음 단계는 …" 1,414 times, 56 minutes until codex's output cap.
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
