// The machine-level marker of the workspace-rules switch. Light on purpose (lazy requires only): the conductor (first-run.ts) calls it after the switch row is on.
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

/** Audit 54 X1: the machine-level word that the switch is on for at least one account of this computer (the engine's `memory_classify.OUTSIDE_MARKER_NAME` / `OUTSIDE_MARKER_SCHEMA`). */
export const OUTSIDE_MARKER_NAME = "workspace-rules-outside.json";
export const OUTSIDE_MARKER_SCHEMA = "agentlas.workspace-rules-outside.v1";

export type MarkerResult = "written" | "present" | "failed";

/**
 * WHAT: one small file, `<memory root>/workspace-rules-outside.json` (0600, `{schema, writtenAt}`, no account id, no memory text), next to `registry.json`.
 * WHO WRITES IT: this function, called by the conductor's step `rules` right after the switch row is on (first-run.ts `runRulesStep`) and again when the step finds the row already on (an account turned on before this build);
 * written with a temporary file and one rename, so a reader never sees half of it, and left alone when a valid one is there.
 * WHO READS IT: the engine's `workspace_rules_on` (memory_classify.py `outside_marker_on`), only for a caller with no host binding - a Claude Code or Codex window opened outside the app, which always opens the first
 * account's store whatever account is current here; with the marker it answers "on", so such a window reads no Personal line and writes none (a second account's or a signed-out state's window no longer reads the first
 * account's Personal preferences nor writes its instructions there). A call that carries a host binding (the app's own engine runs, MCP server, curator bridge) never asks it; the engine hook inside a CLI runtime the app launched (runtime/exec.ts spawnCli) carries none, so it reads the marker exactly like a window opened outside the app. A marker that is there but broken or unreadable counts as on (the narrower side); a missing one as off.
 * WHEN IT GOES: never by this code - turning the switch back off leaves it (the narrower side: an outside window stays out of Personal); it goes with the memory root folder (a device reset).
 * A failure (disk full, no permission) is "failed": the step does not say "done" and looks again. It opens no memory store and never touches another account's file.
 */
export function ensureOutsideMarker(): MarkerResult {
  let temporary: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require("node:path") as typeof import("node:path");
    const folder = (require("../memory/database") as typeof import("../memory/database")).memoryRoot();
    const file = nodePath.join(folder, OUTSIDE_MARKER_NAME);
    let exists = false;
    try {
      const info = fs.lstatSync(file);
      exists = true;
      if (info.isFile() && info.size <= 4096) {
        const value = record(JSON.parse(fs.readFileSync(file, "utf8")));
        if (value?.schema === OUTSIDE_MARKER_SCHEMA) return "present";
      }
    } catch { /* absent or unreadable: written below */ }
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    temporary = nodePath.join(folder, `.${OUTSIDE_MARKER_NAME}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify({ schema: OUTSIDE_MARKER_SCHEMA, writtenAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    if (exists) fs.rmSync(file, { force: true });   // an unusable file (damaged, linked): replaced; a rename over it is not allowed on Windows
    fs.renameSync(temporary, file);
    temporary = null;
    return "written";
  } catch {
    if (temporary) { try { (require("node:fs") as typeof import("node:fs")).rmSync(temporary, { force: true }); } catch { /* a leftover temporary file is ours and empty of memory text */ } }
    return "failed";
  }
}
