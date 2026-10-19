import { closestNames, nameSimilarity } from "../../shared/did-you-mean";

/**







 */
export function toolNameKey(name: string): string {
  return name.toLowerCase().replace(/^mcp__/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function resolveToolNameAlias(names: Iterable<string>, requested: string): string | null {
  const key = toolNameKey(requested);
  if (!key) return null;
  let hit: string | null = null;
  for (const name of names) {
    if (name === requested) return name;
    if (toolNameKey(name) !== key) continue;
    if (hit !== null) return null;
    hit = name;
  }
  return hit;
}

export function closestToolNames(names: Iterable<string>, requested: string, limit = 5): string[] {
  const all = [...names];
  const parts = toolNameKey(requested).split("_").filter((part) => part.length > 2);
  const byWords = parts.length === 0 ? [] : all
    .map((name) => {
      const key = toolNameKey(name);
      return { name, score: parts.filter((part) => key.includes(part)).length };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => row.name);
  // A misspelled name ("raed_file", "bsh") ranks below every name that merely shares a word, or shares none: the shared
  // typo matcher (shared/did-you-mean.ts) puts a name it finds almost identical first, keeps the word-ranked names in their
  // order, and adds looser typo matches last. It only orders and adds names in the refusal; nothing here resolves or runs a call.
  const close = closestNames(requested, all, limit);
  const near = close.filter((name) => nameSimilarity(requested, name) >= 0.85);
  return [...near, ...byWords.filter((name) => !near.includes(name)), ...close.filter((name) => !near.includes(name) && !byWords.includes(name))].slice(0, limit);
}

export function unknownToolMessage(requested: string, names: Iterable<string>): string {
  const near = closestToolNames(names, requested);
  return `Error: unknown tool "${requested}"${near.length ? `. Exact names: ${near.join(", ")}` : ""}`;
}
