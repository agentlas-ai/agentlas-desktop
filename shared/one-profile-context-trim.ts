/*
 * The personal One's profile context is assembled from parts (persona, owner profile with its approved principles, approved memory, a
 * one-time memory use, a briefing action, and for the personal conversation the supervisor guidance) and the Main prompt builder refuses
 * the whole field when it is longer than the limit (mcp/client.ts mainOneProfileContext). Until now that meant one long memory list
 * silently removed the persona, the profile and the supervisor guidance together.
 *
 * Here an over-limit assembly is cut by priority instead. Kept, in this order: supervisor guidance, persona, profile (identity, the
 * owner's context and approved principles), briefing action. Cut first, oldest first: approved memory items ("- [scope] ..." lines,
 * in the store's order), then the rest of the approved-memory block, then the one-time memory use. An assembly within the limit is
 * returned byte for byte as before. No electron import.
 */
export const ONE_PROFILE_CONTEXT_LIMIT = 16_000;
export type OneContextPartKind = "persona" | "profile" | "memory" | "memory-once" | "briefing" | "guidance";
/** The approved memory with its pieces: each item carries its time, so "oldest" never depends on array order. */
export interface OneMemoryPieces { heading: string; items: Array<{ text: string; at: string }>; automatic: string }
export interface OneContextPart { kind: OneContextPartKind; text: string; memory?: OneMemoryPieces }
export interface OneContextComposition { text: string; trimmed: boolean; droppedMemoryItems: number; droppedMemoryBlocks: number; overLimitAfterTrim: boolean }

const MEMORY_ITEM = /^- \[/u;
const MEMORY_HEADING = "[Approved One Memory]";
/** The parts joined as the assembly always was: empty parts omitted, a blank line between. */
export function joinOneContextParts(parts: readonly OneContextPart[]): string {
  return parts.map(part => part.text).filter(Boolean).join("\n\n");
}

export function composeOneProfileContext(
  parts: readonly OneContextPart[], limit: number = ONE_PROFILE_CONTEXT_LIMIT, warn?: (line: string) => void,
): OneContextComposition {
  const full = joinOneContextParts(parts);
  if (full.length <= limit) return { text: full, trimmed: false, droppedMemoryItems: 0, droppedMemoryBlocks: 0, overLimitAfterTrim: false };
  const work = parts.map(part => ({ ...part }));
  const lengthNow = (): number => joinOneContextParts(work).length;
  let droppedMemoryItems = 0, droppedMemoryBlocks = 0;
  const memory = work.find(part => part.kind === "memory" && part.text);
  if (memory?.memory) {
    // Structured: cut whole items, oldest time first (ties keep the stored order), and keep the survivors in their stored order.
    const { heading, automatic } = memory.memory;
    const items = memory.memory.items.map((item, index) => ({ ...item, index }));
    const order = [...items].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.index - y.index));
    const gone = new Set<number>();
    const render = (): string => {
      const kept = items.filter(item => !gone.has(item.index)).map(item => item.text);
      return kept.length ? [heading, ...kept].concat(automatic ? [automatic] : []).join("\n") : automatic;
    };
    for (const item of order) {
      if (lengthNow() <= limit) break;
      gone.add(item.index); droppedMemoryItems += 1;
      memory.text = render();
    }
    if (lengthNow() > limit) { memory.text = ""; droppedMemoryBlocks += 1; }
  } else if (memory) {
    let lines = memory.text.split("\n");
    for (let at = 0; at < lines.length && lengthNow() > limit; ) {
      if (!MEMORY_ITEM.test(lines[at])) { at += 1; continue; }
      lines.splice(at, 1);
      memory.text = lines.join("\n");
      droppedMemoryItems += 1;
    }
    if (!lines.some(line => MEMORY_ITEM.test(line))) {
      lines = lines.filter(line => line !== MEMORY_HEADING);
      memory.text = lines.join("\n");
    }
    if (lengthNow() > limit) { memory.text = ""; droppedMemoryBlocks += 1; }
  }
  const once = work.find(part => part.kind === "memory-once" && part.text);
  if (once && lengthNow() > limit) { once.text = ""; droppedMemoryBlocks += 1; }
  const text = joinOneContextParts(work);
  const overLimitAfterTrim = text.length > limit;
  warn?.(`[one-context] profile context was ${full.length} chars over the ${limit} limit: dropped ${droppedMemoryItems} oldest memory item(s)`
    + `${droppedMemoryBlocks ? ` and ${droppedMemoryBlocks} memory block(s)` : ""}; persona, profile and guidance kept${overLimitAfterTrim ? " (still over the limit after trimming memory)" : ""}`);
  return { text, trimmed: true, droppedMemoryItems, droppedMemoryBlocks, overLimitAfterTrim };
}

/**
 * The assembly and the deferred-relay block that follows it travel in the same field, so the trim limit is what the relay leaves:
 * `limit - (relay block + its separator)`. The relay block is appended after the cut; the total never exceeds the limit (a relay block
 * the size of the relay module's floor used to push a context cut to the limit over it, and the whole field was then dropped).
 */
export function composeOneProfileContextWithRelay(
  parts: readonly OneContextPart[], relayBlock: string | null | undefined, limit: number = ONE_PROFILE_CONTEXT_LIMIT, warn?: (line: string) => void,
): OneContextComposition {
  const relay = relayBlock ?? "";
  const composed = composeOneProfileContext(parts, relay ? limit - relay.length - 2 : limit, warn);
  return relay ? { ...composed, text: [composed.text, relay].filter(Boolean).join("\n\n") } : composed;
}
