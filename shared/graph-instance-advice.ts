// What a graph's name says about the work it was made for.
//
// A graph is for work that comes back with different inputs: find topics, then let the team discuss; monitor performance. It is
// not for one occasion — "make episode 20", "the report of the 19th" — which is done directly. Seen in practice:
// trigger→code→code→eval graphs saved by one room's Goal turns, each renamed per episode, all still on.
// Names that carry a date or an episode number mark an occasion; two names that differ only by such a number are one piece of
// work saved twice. Meaning stays with the model; this only finds the two shapes that are certain.

const MARKERS: RegExp[] = [
  /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g,
  /\d{1,2}\s*월\s*\d{1,2}\s*일/g,
  /\d{1,2}\s*일(?:차)?/g,
  /\d{1,2}\s*월/g,
  /\b\d{1,2}\/\d{1,2}\b/g,
  /제?\s*\d+\s*(?:번째|회차|회|화|편|주차|주|호|차)/g,
  /\b(?:ep|episode|day|week|vol|part|no|season|s|v|r|t)\.?\s*#?\s*\d+\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi,
  /#\d+/g,
];

/** The date or ordinal tokens in a graph name, in the order they appear. */
export function occasionMarkers(name: string): string[] {
  const text = name.normalize("NFKC");
  const found: Array<{ at: number; text: string }> = [];
  for (const pattern of MARKERS) for (const match of text.matchAll(pattern)) found.push({ at: match.index ?? 0, text: match[0].trim() });
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).flatMap(item => seen.has(item.text) ? [] : (seen.add(item.text), [item.text]));
}

/** The name with its dates, ordinals and numbers removed: what the work is called, not which time or item it was for. */
export function recurringWorkName(name: string): string {
  let text = name.normalize("NFKC").toLowerCase();
  for (const pattern of MARKERS) text = text.replace(new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g"), " ");
  return text.replace(/\d+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Two names that differ only by a date or number. Short remainders ("report") are too generic to claim the same work. */
export function sameWorkName(left: string, right: string): boolean {
  const a = recurringWorkName(left), b = recurringWorkName(right);
  return a.length >= 6 && a === b;
}
