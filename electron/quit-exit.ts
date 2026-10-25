// Quit on Windows/Linux — how long each cleanup step took, how the process ends once cleanup is done, and what
// happens to a launch that arrives while Agentlas is quitting.
//
// Windows retest (HEAD f97400bfd on 1.3.88, Win11 ARM64, 2026-10-24): every quit took 27–30 s and ended in a forced
// exit (main.log: "cleanup exceeded 30000ms" or "native exit exceeded 2000ms"), and a launch inside that window was
// ignored (second-instance returned "ignore" once the quit was committed). The log could not say which step waited:
// the daemon was released 0.5 s in, then nothing for 27 s. Three rules kept here:
//   1. Every cleanup step is timed by name; one summary line goes to main.log, and a step that runs past its budget is
//      named (and, for steps that may be left behind, no longer waited for). A forced exit names what was still running.
//   2. Once cleanup is complete, Windows/Linux exit at once. The old path prevented the second will-quit and waited a
//      fixed 2 s grace for a forced exit — every quit paid 2 s and logged an error. macOS keeps its native-exit watchdog.
//   3. A launch during a committed quit is not lost: the quitting process arranges app.relaunch() for its own exit, so
//      Agentlas starts again as soon as this process is gone (Electron's relauncher waits for the old process on Windows,
//      so the single-instance lock is free by then). The launch's own deep link / One flag is carried over.
//
// Pure — no Electron import — so a plain-Node gate drives every branch with a fake app (scripts/test-windows-quit-exit.cjs).

export type QuitStepOutcome = "done" | "failed" | "over-budget";

export interface QuitStepRecord {
  name: string;
  /** Milliseconds from the step's start until it settled, or until its budget ran out. */
  ms: number;
  outcome: QuitStepOutcome;
}

/** A step slower than this is logged on its own line as soon as it settles. */
export const QUIT_STEP_SLOW_MS = 2_000;

export interface QuitStepClock {
  /**
   * Run one named cleanup step. Never throws: a failing step is recorded as "failed" and cleanup goes on.
   * With `budgetMs`, the step is no longer waited for once the budget is spent ("over-budget"); it keeps running in
   * the background and the forced-exit deadline still bounds it. Use a budget only for steps nothing later depends on.
   */
  step<T>(name: string, run: () => Promise<T> | T, options?: { budgetMs?: number }): Promise<T | undefined>;
  /** Steps that have started and not settled, with how long they have been running. */
  running(): Array<{ name: string; ms: number }>;
  records(): QuitStepRecord[];
  /** One line for main.log: total time, each step's time in start order, and what is still running. */
  summary(): { totalMs: number; steps: Record<string, string>; running: string[] };
}

export interface QuitStepClockPorts {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (level: "info" | "warn", message: string) => void;
}

export function createQuitStepClock(ports: QuitStepClockPorts = {}): QuitStepClock {
  const now = ports.now ?? (() => Date.now());
  const setTimer = ports.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = ports.log ?? (() => undefined);
  const startedAt = now();
  const records: QuitStepRecord[] = [];
  const inFlight = new Map<number, { name: string; startedAt: number }>();
  let seq = 0;

  const settle = (id: number, name: string, began: number, outcome: QuitStepOutcome): void => {
    if (!inFlight.has(id) && outcome !== "over-budget") {
      // Already recorded as over-budget; note when it really finished, nothing else.
      const ms = now() - began;
      if (ms >= QUIT_STEP_SLOW_MS) log("info", `[shutdown] step ${name} finished after its budget (${ms}ms, ${outcome})`);
      return;
    }
    inFlight.delete(id);
    const ms = now() - began;
    records.push({ name, ms, outcome });
    if (outcome === "over-budget") log("warn", `[shutdown] step ${name} still running after ${ms}ms; cleanup continues without it`);
    else if (ms >= QUIT_STEP_SLOW_MS) log("warn", `[shutdown] slow step ${name} took ${ms}ms (${outcome})`);
  };

  const running = (): Array<{ name: string; ms: number }> => {
    const at = now();
    return [...inFlight.values()].map((entry) => ({ name: entry.name, ms: at - entry.startedAt }));
  };

  return {
    step<T>(name: string, run: () => Promise<T> | T, options: { budgetMs?: number } = {}): Promise<T | undefined> {
      const id = ++seq;
      const began = now();
      inFlight.set(id, { name, startedAt: began });
      let work: Promise<T>;
      try { work = Promise.resolve(run()); } catch (error) { work = Promise.reject(error); }
      const finished = work.then(
        (value) => { settle(id, name, began, "done"); return value as T | undefined; },
        () => { settle(id, name, began, "failed"); return undefined; },
      );
      const budget = options.budgetMs;
      if (!(typeof budget === "number" && budget > 0)) return finished;
      return new Promise<T | undefined>((resolve) => {
        let done = false;
        const timer = setTimer(() => {
          if (done) return;
          done = true;
          settle(id, name, began, "over-budget");
          resolve(undefined);
        }, budget);
        void finished.then((value) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          resolve(value);
        });
      });
    },
    running,
    records() { return records.map((record) => ({ ...record })); },
    summary() {
      const steps: Record<string, string> = {};
      for (const record of records) steps[record.name] = record.outcome === "done" ? `${record.ms}ms` : `${record.ms}ms ${record.outcome}`;
      return { totalMs: now() - startedAt, steps, running: running().map((entry) => `${entry.name} ${entry.ms}ms`) };
    },
  };
}

export type CleanupDoneExit = "mac-native-watchdog" | "exit-now";

/**
 * How the process ends once JS cleanup and continuity checkpoints are complete (the second will-quit).
 * macOS: a detached watchdog kills the process only if native exit hangs (a blocked Keychain lookup can stop JS
 * timers), so Electron's own exit runs first. Windows/Linux: exit now. There is nothing left to settle, and the old
 * fixed 2 s grace ended every quit in a forced exit logged as an error.
 */
export function cleanupDoneExit(platform: NodeJS.Platform, macWatchdogArmed: boolean): CleanupDoneExit {
  return platform === "darwin" && macWatchdogArmed ? "mac-native-watchdog" : "exit-now";
}

const ONE_FLAGS = ["--one-only", "--one"] as const;

/**
 * The command line for the instance that starts after this one exits, built from the launch that arrived during the
 * quit — never from this process's own argv, which may carry a deep link that was already handled. A development run
 * (`electron <app path>`) keeps its app path. Only what a launch carries for the app is passed on: one agentlas://
 * link (the last one) and the One flag. Chromium switches the OS adds to a second instance's argv are not.
 */
export function relaunchArgsForLaunchDuringQuit(input: {
  defaultApp: boolean;
  currentArgv: readonly string[];
  launchArgv: readonly string[];
}): string[] {
  const args: string[] = [];
  if (input.defaultApp && typeof input.currentArgv[1] === "string" && input.currentArgv[1].length > 0) args.push(input.currentArgv[1]);
  const flag = ONE_FLAGS.find((candidate) => input.launchArgv.includes(candidate));
  if (flag) args.push(flag);
  const link = [...input.launchArgv].reverse().find((arg) => typeof arg === "string" && arg.startsWith("agentlas://"));
  if (link) args.push(link);
  return args;
}

export interface RelaunchAfterQuit {
  /** A launch arrived while quitting. The latest launch wins; returns false once the exit has already applied it. */
  request(args: string[]): boolean;
  /** Called right before the process exits. Arranges exactly one relaunch when a launch arrived. */
  apply(): boolean;
  pending(): string[] | null;
}

/**
 * The executable to start again. An AppImage runs from a mount that disappears with this process, so Electron's default
 * (process.execPath inside the mount) would start nothing: relaunch the AppImage file itself, as the updater does.
 */
export function relaunchExecPath(platform: NodeJS.Platform, appImage: string | undefined, portableFile?: string | undefined): string | undefined {
  // Windows Portable: process.execPath is the %TEMP% extraction that the portable launcher deletes after this
  // process exits (Windows audit ui.md #7). Start the portable launcher file itself.
  if (platform === "win32") return typeof portableFile === "string" && portableFile.trim().length > 0 ? portableFile : undefined;
  return platform === "linux" && typeof appImage === "string" && appImage.trim().length > 0 ? appImage : undefined;
}

export function createRelaunchAfterQuit(
  app: { relaunch(options?: { args?: string[]; execPath?: string }): void },
  execPath: () => string | undefined = () => undefined,
): RelaunchAfterQuit {
  let args: string[] | null = null;
  let applied = false;
  return {
    request(next) {
      if (applied) return false;
      args = [...next];
      return true;
    },
    apply() {
      if (applied || !args) return false;
      applied = true;
      const exec = execPath();
      app.relaunch(exec ? { args, execPath: exec } : { args });
      return true;
    },
    pending() { return args ? [...args] : null; },
  };
}
