import type { UiPresentationSurface } from "./contract";

/**
 * Which screen the answer lands on, from host facts only (never from the request text). null = a channel the contract does not
 * describe (Telegram): no decision is asked and the turn stays as it is today.
 */
export function presentationSurfaceFor(facts: {
  financeDomain: boolean;
  oneMode: boolean;
  builtinOne: boolean;
  /** InvocationWorkspaceBinding.source of the turn, when it came through a paired channel. */
  workspaceSource?: string | null;
}): UiPresentationSurface | null {
  if (facts.workspaceSource === "telegram-one") return null;
  if (facts.workspaceSource === "mobile-one") return "phone-personal-agent";
  if (facts.financeDomain) return "desktop-finance";
  if (facts.oneMode) return facts.builtinOne ? "desktop-one" : "desktop-personal-agent";
  return "desktop-work";
}
