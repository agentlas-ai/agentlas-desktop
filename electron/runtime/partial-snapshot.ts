// RunnerEvents.onPartial hands over the WHOLE answer so far (a snapshot), never a delta: Codex bodyText(), Claude
// combined(), ACP/Antigravity/Grok/Kimi/Cursor `text`, BYOK `acc`, local `continuedText + partial`. Every consumer
// replaces what it holds with the newest call (the live bubble, advanceMainLivePartial, swarm/firm emit "partial").
// A recorder that APPENDS each call keeps the first words N times: production journal kept an
// observed-partial-extract of 4,096 chars for a 279-char answer, and the next turn replayed it as "Previous turns"
// (a 4,096-char row for a 279-char answer, inside a 20,453-char gap prompt). Recorders keep the newest snapshot instead.

/** The partial a recorder keeps after one more onPartial call. An empty call never erases what was seen. */
export function newestPartialSnapshot(kept: string, snapshot: string, cap: number, keep: "head" | "tail"): string {
  if (!snapshot) return kept;
  if (snapshot.length <= cap) return snapshot;
  return keep === "tail" ? snapshot.slice(-cap) : snapshot.slice(0, cap);
}
