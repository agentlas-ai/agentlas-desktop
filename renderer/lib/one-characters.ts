export const ONE_CHARACTER_OPTIONS = [
  { id: "orange-dino", label: "Dino", src: "/brand/one-characters/orange-dino.png", tone: "orange", style: "original" },
  { id: "blue-wave-2d", label: "Wave", src: "/brand/one-characters/blue-wave-2d.png", tone: "blue", style: "sketch" },
  { id: "green-cloud-2d", label: "Cloud", src: "/brand/one-characters/green-cloud-2d.png", tone: "green", style: "sketch" },
  { id: "purple-beacon-2d", label: "Beacon", src: "/brand/one-characters/purple-beacon-2d.png", tone: "purple", style: "sketch" },
  { id: "amber-pod-2d", label: "Pod", src: "/brand/one-characters/amber-pod-2d.png", tone: "amber", style: "sketch" },
  { id: "orange-sprout-2d", label: "Sprout", src: "/brand/one-characters/orange-sprout-2d.png", tone: "peach", style: "sketch" },
  { id: "red-triangle-2d", label: "Peak", src: "/brand/one-characters/red-triangle-2d.png", tone: "red", style: "sketch" },
  { id: "blue-wave", label: "Wave", src: "/brand/one-characters/blue-wave.png", tone: "blue", style: "original" },
  { id: "green-cloud", label: "Cloud", src: "/brand/one-characters/green-cloud.png", tone: "green", style: "original" },
  { id: "purple-beacon", label: "Beacon", src: "/brand/one-characters/purple-beacon.png", tone: "purple", style: "original" },
  { id: "amber-pod", label: "Pod", src: "/brand/one-characters/amber-pod.png", tone: "amber", style: "original" },
  { id: "orange-sprout", label: "Sprout", src: "/brand/one-characters/orange-sprout.png", tone: "peach", style: "original" },
  { id: "red-triangle", label: "Peak", src: "/brand/one-characters/red-triangle.png", tone: "red", style: "original" },
] as const;

export type OneCharacterId = (typeof ONE_CHARACTER_OPTIONS)[number]["id"];
export type OneCharacterStyle = (typeof ONE_CHARACTER_OPTIONS)[number]["style"];

export function oneCharacterForTone(tone: string): (typeof ONE_CHARACTER_OPTIONS)[number] {
  const normalized = tone.replace(/^character:/, "").trim().toLowerCase();
  return ONE_CHARACTER_OPTIONS.find((item) => item.id === normalized)
    ?? ONE_CHARACTER_OPTIONS.find((item) => item.tone === normalized && item.style === "sketch")
    ?? ONE_CHARACTER_OPTIONS[0];
}
