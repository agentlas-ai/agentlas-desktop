/*
 * The personal agent's write gate, for files that must not import the home module (F-6): `one_sealed` / `one_away` or null.
 * One answer, no label, no pointer, no key: it reads home.ts lazily (a process without the home module answers null, as a `legacy` computer does).
 * Read by: ipc.ts (the owner's profile and conversation doors), memory/owner-mutations.ts (edit / forget of a Personal line), memory/curator.ts, mobile-bridge/authority.ts, finance/experience.ts (a read: why a briefing is not registered).
 * Not read by memory/dreaming.ts (desktop 5): dreaming consolidates the AGENTS' lines (`agent_repo`), never the personal agent's Personal lines, so a sealed or away computer keeps consolidating.
 */
export function personalWriteRefusal(): "one_sealed" | "one_away" | null {
  try { return (require("./home") as typeof import("./home")).oneWriteRefusal(); } catch { return null; }
}
