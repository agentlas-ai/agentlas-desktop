// The first-run step `workspace-rules` (Agentlas 2.0 P5; "the switch - one meta line" and 5.6; decision).
//
// WHAT IT IS: one row, `workspace_rules_state` = `on`, in the account's ROOT memory store (`memory_store_meta`, the key is the ruleset's `workspaceRules.stateMetaKey`). Every reader asks that row at the
// moment of use (`memory/classification.ts workspaceRulesOn`, the engine's `memory_classify.workspace_rules_on`); a missing row, a missing table or any other value is OFF. Nothing else is written here:
// not the owner's rules file (nothing is put into "My rules" by itself), not a memory line, not a table or a column.
//
// ALSO ONE MACHINE FILE: `outside-marker.ts` `ensureOutsideMarker`, written after the row (this file writes no file), read only by the engine for windows opened outside the app.
//
// WHO WRITES IT: `flipWorkspaceRules` below, called by the conductor's step `rules` (first-run.ts) and by nothing else. `turnWorkspaceRulesOff` is its reversal (support and tests; while the migration is
// enabled the step turns the row on again at the next look, because the step is derived from the row, not from a table of progress of ours).
//
// WHY A FLIP MUST RESET CACHES: the recall policy filters memory lines by the switch, but a flip writes no memory line, so neither the selection cache's source digest nor the generation pack's change journal
// sees it. Two things make a flip reach every process: (1) `context.ts selectedMemorySection` puts the switch into the cache identity (only when on), and every process reads the row itself at use, so the
// background service learns of a flip at its next read - no signal, no timer; (2) the flip clears this process's own caches at once (`clearSelectedMemoryContextCache`, which also runs the generation pack's invalidator).
//
// Light on purpose: lazy requires only, so a test or the daemon can load it without the conductor.
import { workspaceRulesStateKey, workspaceRulesValueOn } from "../../shared/memory-classification";

const LAYOUT_KEY = "memory_layout";
const SPLIT_LAYOUT = "split-1";

type RootDb = import("better-sqlite3").Database;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

/** The usable classification rules of this build, or null (the ruleset copy is damaged, older than the classification, or missing). Lazy: the module pulls in the prompt-order table. */
function currentRules(): Json | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("../memory/classification") as typeof import("../memory/classification")).memoryClassificationRules() as Json | null;
}

/**
 * Finding 4 (P3a): the desktop reads the switch as OFF whenever its ruleset copy cannot be read, so a flip made then would show "on" in the store and behave as off. The step refuses in that state, and also
 * when the copy is older than 1.7.0 (it lacks the keys the readers and the writers ask for after the switch). Structure only: no word list, no version string compared.
 */
export function rulesetCarriesSwitch(): boolean {
  try {
    const rules = currentRules();
    if (!rules) return false;
    const user = record(record(rules.stores)?.user_identity);
    const admission = record(user?.admission);
    return typeof record(rules.workspaceRules)?.stateMetaKey === "string"
      && record(user?.readers)?.preferenceAfterWorkspaceRules === "one-family-only"
      && record(admission?.desktop)?.requiresPersonalConversationAfterWorkspaceRules === true
      && Array.isArray(record(admission?.engineHook)?.kindsAfterWorkspaceRules);
  } catch { return false; }
}

/** The meta key the switch lives under (the ruleset's own name for it, else the default). */
export function switchKey(): string {
  try { return workspaceRulesStateKey(currentRules() as Parameters<typeof workspaceRulesStateKey>[0]); } catch { return workspaceRulesStateKey(null); }
}

/** The switch as the store says it (no ruleset check): the value is exactly `on`. A store that cannot be read is off. */
export function switchRowIsOn(root: RootDb): boolean {
  try {
    const row = root.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(switchKey()) as { value?: unknown } | undefined;
    return workspaceRulesValueOn(row?.value);
  } catch { return false; }
}

/** Drops what this process kept that depends on the switch (the selected-memory cache and, through its invalidator, the generation packs). Never throws. */
export function resetSwitchCaches(): void {
  try { (require("../memory/selected-context-cache") as typeof import("../memory/selected-context-cache")).clearSelectedMemoryContextCache(); } catch { /* a cache that is not loaded holds nothing */ }
}

export type FlipResult = "on" | "already_on" | "layout_not_split";

/**
 * The flip: ONE statement, atomic, that writes `on` only while the same store still says `memory_layout` = `split-1` (a layout the engine paused or took back between the step's look and this write is
 * not flipped over). Re-reads the row after the write: the answer is what the store says, never what was asked. Resets this process's caches only when the row changed. Throws what SQLite throws (a busy
 * store is the caller's to wait out).
 */
export function flipWorkspaceRules(root: RootDb): FlipResult {
  const key = switchKey();
  if (switchRowIsOn(root)) return "already_on";
  const wrote = root.prepare(
    "INSERT INTO memory_store_meta(key,value) SELECT ?, 'on' WHERE (SELECT value FROM memory_store_meta WHERE key=?) = ? ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, LAYOUT_KEY, SPLIT_LAYOUT);
  if (!wrote.changes) return "layout_not_split";
  const now = switchRowIsOn(root);
  resetSwitchCaches();
  return now ? "on" : "layout_not_split";
}

export type OffResult = "off" | "already_off";

/**
 * The reversal: the row is removed (not set to a value), so the store is as it was before the first flip and every reader answers as it did before 1.7.0. Caches are reset again. Idempotent: on, off, on leaves one row
 * or none. A reader that never knew the row (an older build) was never affected by it.
 */
export function turnWorkspaceRulesOff(root: RootDb): OffResult {
  const removed = root.prepare("DELETE FROM memory_store_meta WHERE key=?").run(switchKey());
  resetSwitchCaches();
  return removed.changes ? "off" : "already_off";
}

/**
 * Does the one-time pick list have something to offer? (the end notice carries one line, only when at least one candidate line exists.) Reads only, through the same service the screen asks
 * (`workspaceRules.get`); the "shown once" state is the screen's (`pickNotice`), so a list the owner already dealt with is not announced again. Never throws.
 */
export function pickListHasCandidates(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const status = (require("../workspace-rules/service") as typeof import("../workspace-rules/service")).workspaceRulesGet();
    return status.state === "on" && status.pickNotice === "none" && status.candidatesAvailable > 0;
  } catch { return false; }
}
