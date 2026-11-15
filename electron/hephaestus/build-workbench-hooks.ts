// One notification between the Build turn and the Build window's store: "this build just registered an agent". Kept apart so the
// builder does not know about owners, the database or the window (the IPC module sets the listener once at start-up).
export interface BuildAgentCreated { workspace: string; packageRoot: string; agentId: string }
let listener: ((input: BuildAgentCreated) => void) | null = null;

export function setBuildAgentCreatedListener(fn: ((input: BuildAgentCreated) => void) | null): void { listener = fn; }

/** Never throws: a listener failure must not fail the Build that already registered its agent. */
export function notifyBuildAgentCreated(input: BuildAgentCreated): void {
  try { listener?.(input); } catch (error) { console.warn(`[build] workbench link not recorded: ${error instanceof Error ? error.message : String(error)}`); }
}
