/**
 * A model sometimes names a tool the way another runtime showed it earlier in the same conversation. Measured
 * 2026-10-16 (Hope 1:1, Codex turn then an Agentlas Light turn): Codex had called "codex_apps.google_calendar.search_events",
 * Light copied that name from the history, this host registered "mcp__codex_apps__google_calendar_search_events", and the
 * call failed "unknown tool" with no hint, so the turn ended without an answer.
 *
 * Only separators and the "mcp__" prefix are ignored, and only a single exact match resolves. Anything else stays unknown,
 * and the refusal names the closest exact tool names so the model can retry with one of them.
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
  const parts = toolNameKey(requested).split("_").filter((part) => part.length > 2);
  if (parts.length === 0) return [];
  return [...names]
    .map((name) => {
      const key = toolNameKey(name);
      return { name, score: parts.filter((part) => key.includes(part)).length };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => row.name);
}

export function unknownToolMessage(requested: string, names: Iterable<string>): string {
  const near = closestToolNames(names, requested);
  return `Error: unknown tool "${requested}"${near.length ? `. Exact names: ${near.join(", ")}` : ""}`;
}
