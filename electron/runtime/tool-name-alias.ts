import { closestNames, nameSimilarity } from "../../shared/did-you-mean";

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

/**
 * The other direction: a model writes a server's tool by its own short name where this host registered the server-qualified one.
 * Light, 2026-10-22 (Finance 1008 rs-R02 and rs-S07, the same sentence): one agentlas_code program called "harness_call" four times at
 * once, this host had "mcp__agentlas-turn__harness_call", and toolNameKey keeps the server part, so all four were refused and the model
 * left code mode with no drawdown computed. The app's prompt text and the tool menu's server index both name MCP tools by that short
 * name. When exactly one directly callable MCP tool has the short name, it is the tool meant; the resolved name then goes through the
 * same menu and approval as a call that spelled it in full. A short name two servers share stays unknown, a tool behind the lazy menu
 * is left to the menu's own path hint (it needs prepare first, so `short` is null for it), and a spelling whose whole-name key some
 * registered tool has is left to resolveToolNameAlias (resolved or ambiguous there).
 */
export function resolveShortToolName(tools: Iterable<{ name: string; short: string | null }>, requested: string): string | null {
  const key = toolNameKey(requested);
  if (!key) return null;
  let hit: string | null = null;
  for (const { name, short } of tools) {
    if (toolNameKey(name) === key) return null;
    if (short === null || toolNameKey(short) !== key) continue;
    if (hit !== null) return null;
    hit = name;
  }
  return hit;
}

/**
 * A model that was told the exact name of a prefixed tool ("mcp__agentlas-turn__harness_call") can carry that prefix over to a
 * tool that has none ("read_tool_result"): Light's 2026-10-21 run R02 called "mcp__agentlas-turn__read_tool_result" six times, each
 * refusal listing prefixed names that shared the prefix with the request and none of them the tool it meant. When the last segment
 * of a server-qualified spelling is a registered tool's own name, that tool is the one meant. Hint only: nothing here resolves a call.
 */
export function bareToolFor(names: Iterable<string>, requested: string): string | null {
  const parts = requested.split(/__|[./]/).filter(Boolean);
  const bare = parts.length > 1 ? parts[parts.length - 1] : "";
  if (!bare || bare === requested) return null;
  for (const name of names) if (name === bare) return name;
  return null;
}

export function closestToolNames(names: Iterable<string>, requested: string, limit = 5): string[] {
  const all = [...names];
  const bare = bareToolFor(all, requested);
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
  const ordered = [...near, ...byWords.filter((name) => !near.includes(name)), ...close.filter((name) => !near.includes(name) && !byWords.includes(name))];
  return (bare ? [bare, ...ordered.filter((name) => name !== bare)] : ordered).slice(0, limit);
}

export function unknownToolMessage(requested: string, names: Iterable<string>): string {
  const all = [...names];
  const near = closestToolNames(all, requested);
  const bare = bareToolFor(all, requested);
  const note = bare ? ` ("${bare}" is a tool by itself: call it without the "${requested.slice(0, requested.length - bare.length)}" prefix.)` : "";
  return `Error: unknown tool "${requested}"${near.length ? `. Exact names: ${near.join(", ")}` : ""}${note}`;
}
