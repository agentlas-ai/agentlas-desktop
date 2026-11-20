import { serverNameUp } from "./one-agent-name";
import type { OneProfile } from "./one-profile";

/**
 * the closed lists of the values a desktop reports about itself to the places registry (`POST /api/desktop/place`).
 * They are COPIES of the server's own lists (web `companion-prompt.mjs` COMPANION_CHARACTERS / COMPANION_STYLES): a value outside them makes the server refuse the whole report.
 * scripts/test-c1-place-values.cjs reads the web checkout's lists and fails when these two differ (skipped, said so, when there is no sibling checkout).
 */
export const PLACE_CHARACTERS = ["orange-dino", "blue-wave", "green-cloud", "purple-beacon", "amber-pod", "orange-sprout", "red-triangle"] as const;
export const PLACE_STYLES = ["casual", "polite", "brief", "warm"] as const;
export type PlaceStyle = (typeof PLACE_STYLES)[number];
/** The face every personal agent starts with (`character:orange-dino`, store/one-profile.ts defaultProfile). */
export const DEFAULT_PLACE_PRESET = "orange-dino";
/** What a desktop whose owner never picked a style reports: the one of the four that is polite in Korean (the stand-in the older mirror already used). */
export const DEFAULT_PLACE_STYLE: PlaceStyle = "polite";

export function isPlaceStyle(value: unknown): value is PlaceStyle {
  return typeof value === "string" && (PLACE_STYLES as readonly string[]).includes(value);
}

/** The preset a profile's `avatarIcon` stands for: `character:<name>` with a name the server knows; anything else (a picture of the owner's, nothing) reports the default face. */
export function placePresetOf(avatarIcon: string | undefined): string {
  const name = typeof avatarIcon === "string" && avatarIcon.startsWith("character:") ? avatarIcon.slice("character:".length) : "";
  return (PLACE_CHARACTERS as readonly string[]).includes(name) ? name : DEFAULT_PLACE_PRESET;
}

/** True while the owner has not chosen a face: the stored avatar is absent or the default character (the only case a server suggestion may be applied). */
export function faceIsDefault(avatarIcon: string | undefined): boolean {
  return avatarIcon === undefined || avatarIcon === `character:${DEFAULT_PLACE_PRESET}`;
}

export interface PlaceValues {
  machine: string; agent: string; preset: string; style: string; reach: string[]; runnable: boolean; v: number;
  /**
   * Connector roads this computer has MEASURED as ready (ids of the server's connector cards, electron/connectors/desktop-paths.ts; decision: the phone and each computer decide by data which road a task takes).
   * Absent / empty = none reported (an older desktop looks the same). Read by the server's route (phone agent turns, hand-off to the computer that has the road); dropped when the person disconnects this computer.
   */
  paths?: string[];
}

const clean = (value: string): string => value.replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * What this desktop reports about its place: the profile's name (as the server counts it, at most 12 code points), face and style, and the machine's name; null when a name is empty after cleaning
 * (nothing is reported then). `reach` and `runnable` are not read from anything yet: the places list shows the desktop, the capability lines come after the first version (reported as nothing / yes).
 */
export function placeValuesOf(profile: Pick<OneProfile, "displayName" | "avatarIcon" | "style">, machine: string, v: number): PlaceValues | null {
  const agent = clean(serverNameUp(profile.displayName)).slice(0, 40), name = clean(machine).slice(0, 60);
  if (!agent || !name) return null;
  return { machine: name, agent, preset: placePresetOf(profile.avatarIcon), style: profile.style ?? DEFAULT_PLACE_STYLE, reach: [], runnable: true, v };
}
