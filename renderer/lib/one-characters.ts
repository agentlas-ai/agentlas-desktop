// The named characters: round pictures (512 px WebP, circle of content, transparent outside) that the agent's
// portrait draws edge to edge. The ids are stored values (profiles, the phone, the service) and never change;
// only the pictures were redrawn. The old "-2d" sketch ids are still accepted everywhere a stored id is read and
// resolve to the same picture as their base id (`oneCharacterBaseId`).
export const ONE_CHARACTER_OPTIONS = [
  { id: "orange-dino", label: "Dino", src: "/brand/one-characters/orange-dino.webp", tone: "orange", style: "original" },
  { id: "blue-wave", label: "Drop", src: "/brand/one-characters/blue-wave.webp", tone: "blue", style: "original" },
  { id: "green-cloud", label: "Cloud", src: "/brand/one-characters/green-cloud.webp", tone: "green", style: "original" },
  { id: "purple-beacon", label: "Gem", src: "/brand/one-characters/purple-beacon.webp", tone: "purple", style: "original" },
  { id: "amber-pod", label: "Moon", src: "/brand/one-characters/amber-pod.webp", tone: "amber", style: "original" },
  { id: "orange-sprout", label: "Sprout", src: "/brand/one-characters/orange-sprout.webp", tone: "peach", style: "original" },
  { id: "red-triangle", label: "Peak", src: "/brand/one-characters/red-triangle.webp", tone: "red", style: "original" },
] as const;

export type OneCharacterId = (typeof ONE_CHARACTER_OPTIONS)[number]["id"];
export type OneCharacterStyle = (typeof ONE_CHARACTER_OPTIONS)[number]["style"];

/** `blue-wave-2d` (a retired sketch id that may still be stored) -> `blue-wave`; every other id is returned as is. */
export function oneCharacterBaseId(id: string): string {
  return id.endsWith("-2d") ? id.slice(0, -3) : id;
}

/** Picture of a stored character id (old "-2d" ids included), or null for an id this build does not know. */
export function oneCharacterSrcForId(id: string): string | null {
  const base = oneCharacterBaseId(id);
  return ONE_CHARACTER_OPTIONS.find((item) => item.id === base)?.src ?? null;
}

export function oneCharacterForTone(tone: string): (typeof ONE_CHARACTER_OPTIONS)[number] {
  const normalized = oneCharacterBaseId(tone.replace(/^character:/, "").trim().toLowerCase());
  return ONE_CHARACTER_OPTIONS.find((item) => item.id === normalized)
    ?? ONE_CHARACTER_OPTIONS.find((item) => item.tone === normalized)
    ?? ONE_CHARACTER_OPTIONS[0];
}
