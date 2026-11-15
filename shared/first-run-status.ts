/**
 * What the screen reads about the 2.0 first-run cleanup (Agentlas 2.0 redesign backend C): the reasons it is waiting, as codes, and whether it is finished.
 * Machine values only; the screen words them. Types only: nothing here is read at run time.
 *
 *  - `applicable: false`  the migration switch is off on this build (`AGENTLAS_FIRST_RUN_MIGRATION`): there is no cleanup to show. `done` is false and means nothing; a screen
 *                         must not draw "finished" from it.
 *  - `applicable: true, done: false`  the cleanup is running or waiting; `openCodes` says what it waits on (`first_run:<code>`), empty while it simply has not finished.
 *  - `applicable: true, done: true`   this account's end marker is written and no step is still owed. `openCodes` may still name a step that ended without finishing (a capped or
 *                         waiting label step); they are kept in memory only, so they are empty again after a restart.
 */
export interface FirstRunStatus {
  applicable: boolean;
  done: boolean;
  openCodes: string[];
  /**
   * The part of `openCodes` that waiting will not clear (a skip reason the engine said asking again cannot change, or a wait whose bounded retries are used up). The screen words these as
   * "stopped", not "paused for now"; the rest of `openCodes` is still being retried. Absent when there is none (and from an older Main): treat as empty, the old wording. In memory only.
   */
  finalCodes?: string[];
  /**
   * The step the cleanup is on ("4/9"), only while it runs (`done: false`). Counted from the conductor's own step order (electron/migration/first-run.ts `PROGRESS_STEPS`), set when a pass starts a step.
   * Absent when no pass of this run has started a step yet (right after a start, after a restart) and from an older Main: the screen draws words alone. In memory only.
   */
  step?: { n: number; total: number };
  /**
   * What the cleanup moved, only once it is finished (`done: true`; a half count is never shown as a result). Cumulative over the runs of the one move (a restart in between does not lose the part
   * before it). A key is present only when it is known: an older Main, and an account that finished before the totals were kept, carry no `counts` at all (the screen draws the names alone).
   * agents = agent folders moved; memory = memory lines moved; removed = old memories nobody read that were deleted.
   */
  counts?: { agents?: number; memory?: number; removed?: number };
}
/** The closed words of the retry call (`firstRun.retry`). `running`: a step is running right now. `not_running_here`: this process is not the one running the cleanup (the background service is, or it is off). `nothing_to_retry`: nothing is stopped. */
export type FirstRunRetryAnswer = { ok: true; asked: "again" } | { ok: false; code: "running" | "not_running_here" | "nothing_to_retry" | "untrusted_sender" | "unavailable" };
export type FirstRunStatusAnswer = ({ ok: true } & FirstRunStatus) | { ok: false; code: "untrusted_sender" | "unavailable" };
