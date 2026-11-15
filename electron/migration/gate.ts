// The switch of the 2.0 first-run migration and the small shared state the background memory jobs read while it moves rows
// (decision, section 11).
//
// This file has no imports on purpose: dreaming, the English migration and the memory screen read it, and none of them may pull the conductor in.
//
// ★ THE SWITCH. Off means the conductor (`first-run.ts`) starts nothing and the app starts exactly as it did before this change: the steps that were
//   already in the start-up chain (agent folders, experience chips, the One drawer import and its five-minute timer) stay where they were and run
//   the way they ran. A development build can open the owner's real `~/.agentlas`; turning this on moves real memory, so it is turned on by a separate
//   commit after the audit - or, in a test, by the environment variable below (a value of `0` forces it off).
export const FIRST_RUN_MIGRATION_ON_BY_DEFAULT = true;
export const FIRST_RUN_MIGRATION_ENV = "AGENTLAS_FIRST_RUN_MIGRATION";

/** True only for a packaged app (`app.isPackaged === true`); a plain Node process, a test and a development run are not. Read lazily: this file has no imports. */
function packagedBuild(): boolean {
  try { return (require("electron") as { app?: { isPackaged?: boolean } }).app?.isPackaged === true; } catch { return false; } // eslint-disable-line @typescript-eslint/no-require-imports
}

export function firstRunMigrationEnabled(): boolean {
  const value = process.env[FIRST_RUN_MIGRATION_ENV]?.trim();
  // A packaged build (the installed app, a Dev channel, a local package) uses the owner's real `~/.agentlas`: while the default is off, the variable does not turn it on there (defect 10).
  if (value === "1") return FIRST_RUN_MIGRATION_ON_BY_DEFAULT || !packagedBuild();
  if (value === "0") return false;
  return FIRST_RUN_MIGRATION_ON_BY_DEFAULT;
}

// ★ THE MOVE GATE. While the conductor has an engine call that deletes or moves memory rows in flight, the background jobs that rewrite rows
//   (dreaming, the English migration) do not start a pass. In-process on purpose: the conductor runs in Main only, and so do those jobs (the daemon
//   starts neither). The engine's own lock (`.split.lock`) is a file lock Node cannot read, and it only exists while a call runs.
let moving = 0;
const idleListeners = new Set<() => void>();

export function memoryMoveActive(): boolean { return moving > 0; }

/** The conductor calls this before an engine call that writes and calls the returned function when the call settles (idempotent). */
export function beginMemoryMove(): () => void {
  moving += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    moving -= 1;
    if (moving === 0) for (const listener of [...idleListeners]) { try { listener(); } catch { /* a listener cannot hold the move */ } }
  };
}

/** A job that stood aside while rows moved is told once when nothing moves any more (a signal, not a timer). Returns the unsubscribe. */
export function onMemoryMoveIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => { idleListeners.delete(listener); };
}

// ★ CHANGE SIGNAL (Agentlas 2.0 BB-1a). The screen's first-run line used to read this state only when it opened or regained focus. Whatever changes what `readFirstRunStatus` answers
//   (an open code coming or going, the step the conductor is on, the end) calls `emitFirstRunStateChange()`; Main sends the renderer one `firstRun:changed` per burst and the screen reads once.
//   No timer and no polling: a burst of changes in one tick is one call (a microtask), and a call with no listener costs nothing. In memory only.
const stateListeners = new Set<() => void>();
let stateChangeQueued = false;
export function onFirstRunStateChange(listener: () => void): () => void { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; }
export function emitFirstRunStateChange(): void {
  if (stateChangeQueued || stateListeners.size === 0) return;
  stateChangeQueued = true;
  queueMicrotask(() => { stateChangeQueued = false; for (const listener of [...stateListeners]) { try { listener(); } catch { /* a listener cannot hold the migration */ } } });
}

// ★ STEP. Which of the conductor's steps it is on, as "n of total" (the line's "4/9"). Set by the conductor from its own step order when a pass starts a step of the first run, cleared when the account's end
//   notice is written and when the account changes. In memory only, so a restart shows no step until a pass has really started one again (a stale "4/9" is never shown for work that is not running).
let currentStep: { n: number; total: number } | null = null;
export function setFirstRunStep(next: { n: number; total: number } | null): void {
  const same = (currentStep === null && next === null) || (currentStep !== null && next !== null && currentStep.n === next.n && currentStep.total === next.total);
  if (same) return;
  currentStep = next;
  emitFirstRunStateChange();
}
export function firstRunStep(): { n: number; total: number } | null { return currentStep ? { ...currentStep } : null; }

/** App-store meta row of the move's totals, one per account (`<prefix><account key>`): written by the conductor, read by `readFirstRunStatus` once the end notice exists; overwritten by the next move, kept with the app store. */
export const FIRST_RUN_COUNTS_KEY_PREFIX = "first-run-counts:v1:";

// ★ OPEN CODES. Reasons the migration is waiting on the person or the machine, as codes (never sentences): the memory screen's existing
//   "could not read this store" line prints them as they are. In memory only; the conductor looks again at the next start.
const openCodes = new Map<string, number>();
export function noteFirstRunOpenCode(code: string): void {
  const isNew = !openCodes.has(code);
  openCodes.set(code, Date.now());
  let dropped = false;
  while (openCodes.size > 8) { openCodes.delete(openCodes.keys().next().value as string); dropped = true; }
  if (isNew || dropped) emitFirstRunStateChange();   // a code seen again changes nothing the screen reads
}
export function clearFirstRunOpenCode(code: string): void { const had = openCodes.delete(code); const wasFinal = finalCodes.delete(code); if (had || wasFinal) emitFirstRunStateChange(); }
export function firstRunOpenCodes(): string[] { return [...openCodes.keys()]; }
// ★ FINAL CODES. An open code whose cause waiting will not clear (the engine said asking again changes nothing, or the conductor's bounded asking is used up): the screen may say "stopped", not "paused for now".
//   A subset of the open codes, in memory only, gone with the code (`clearFirstRunOpenCode`) and with the process; nothing is stored.
const finalCodes = new Set<string>();
export function markFirstRunFinalCode(code: string): void { if (openCodes.has(code) && !finalCodes.has(code)) { finalCodes.add(code); emitFirstRunStateChange(); } }
export function firstRunFinalCodes(): string[] { return [...finalCodes].filter((code) => openCodes.has(code)); }
/** Test seam. */
export function resetFirstRunOpenCodesForTests(): void { openCodes.clear(); finalCodes.clear(); currentStep = null; stateListeners.clear(); stateChangeQueued = false; }
