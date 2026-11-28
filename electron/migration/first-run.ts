// The 2.0 first-run migration conductor (Agentlas 2.0; decision; section 11, section G).
//
// One migration that runs once, in the background, after the window is up, and moves everything an older version left into the 2.0 layout.
// It is OFF unless `firstRunMigrationEnabled()` (gate.ts) says so. Off, this module is never loaded and the app starts as it did before it existed.
//
// The steps, in order (a step that has nothing to do answers it from its own marker, never from a table of progress of ours):
//   (2)  agent folders        done by the start chain before this starts (`agents/home-move.ts`); its report comes in through `noteLegacySteps`
//   (3)  experience chips     same (`memory/chip-absorb.ts`)
//   (3') One drawer           the last import, then `one-import:retired` in the root meta; the import's start-up call and five-minute timer are not made any more
//   (1)  engine copies        engine `steps --only engine_copies`, once per app start, never holds anything back
//   (4)  empty turn records   engine `steps --only empty_turns` until nothing is left
//   (5a) memory classification, code only   engine `reclassify` (the lines learned in exactly one existing project folder go to that project); before (6) when it can run, in any
//                             order against (6) (the engine gives the same result either way), and it never holds (6) back: a stop of (5a) is a stop of (5a)
// (5b) people lines the engine offers the lines about the owner as a person, the connected model names their store, the engine applies the checked answers
//                             (first-run-labels.ts). It is the LAST thing the conductor does, never waits for the end notice, may take days (no model connected = `waiting_model`
//                             until a runtime is connected) and shows as the open code `first_run:labels_pending` while it is not finished
//   (6)  memory move          engine `steps --only memory_move`; the engine turns the layout switch on and writes `layout_switch_epoch` itself
//   (6b) workspace rules      the workspace-rules switch (Agentlas 2.0 P5, first-run-rules.ts): one root meta row `workspace_rules_state` = `on`, only for an account whose move is complete (the marker the end notice
//                             reads) and only when every engine copy on this computer is confirmed now (an old copy in an open Claude Code / Codex window would keep reading Personal lines). It sits BEFORE
// the end notice, and while it is owed the open-work marker keeps a live background service from keeping the account out of it (section "workspace-rules")
// (7) session files / code index `relocateProjectIndexesOnce` after (6) has written the layout, and once at every app start (lstat only when nothing is left)
//   (h)  harness cleanup      drops the tables of the deleted AGI unblocker and cleans the Alive tables of the deleted One / Work lives (harness-cleanup.ts), one bounded unit per pass
//   (8)  end notice           once per account (`first-run-notice:v2:<account>` in the app meta), one sentence without numbers
//   at quit: one VACUUM of the root through the engine, after the stores are closed
//
// How it runs: `createIdleJob` (the scheduler the other unattended Main jobs use). It never polls: it looks at start, when a run slot frees, on a chat or
// runtime change, when the machine wakes, when an agent folder moved, when the engine is detected again, and when the account changes. One engine call per
// pass, and a pass is not started while a run holds or waits for a slot.
// Where it runs: Main only (`openedStoreMigrationRole() === "owner"`). The daemon never calls it, and a second caller on the same store is told `busy` by the engine's lock.
//
// While an agent-folder root move is open (agents/root-move.ts journal) no engine step starts: the open code `first_run:root_move` shows and the next signal looks again.
//
// What it does NOT do: ask the person anything, move or classify rows itself (the engine does), keep a table, undo a move to 1.x. The only model call is step 5b's (first-run-labels.ts).
import crypto from "node:crypto";
import { IDLE_JOB_FAILURE_WAITS_MS, type IdleJob } from "../memory/idle-job";
import type { HomeMoveReport } from "../agents/home-move";
import type { FirstRunRetryAnswer } from "../../shared/first-run-status";
import type { ChipAbsorbResult } from "../memory/chip-absorb";
import { FIRST_RUN_COUNTS_KEY_PREFIX, beginMemoryMove, clearFirstRunOpenCode, emitFirstRunStateChange, firstRunMigrationEnabled, markFirstRunFinalCode, noteFirstRunOpenCode, resetFirstRunOpenCodesForTests, setFirstRunStep } from "./gate";
import { firstRunStartRefusal } from "./start-guard";
import { HARNESS_ORPHAN_TABLES, harnessWorkLeft, runAliveCleanupUnit, runHarnessCleanup, type AliveUnitResult } from "./harness-cleanup";
import {
  AGAIN_PAUSE_MS, BUDGET_SECONDS, CALL_TIMEOUT_MS, COPIES_TIMEOUT_MS, VACUUM_CALL_TIMEOUT_MS, VACUUM_ENGINE_TIMEOUT_SECONDS, WAIT_PAUSE_MS,
  createEngineRunner, judgeClassify, judgeSteps, lastJsonLine, probeEngineRoot,
  type Disposition, type EngineProbe, type EngineRunner, type EngineStep,
} from "./first-run-engine";
import { markWaitingModel, runLabelBatch, defaultLabelModel, defaultLabelRoute, type LabelDeps, type LabelOutcome } from "./first-run-labels";
import { flipWorkspaceRules, pickListHasCandidates, rulesetCarriesSwitch, switchKey } from "./first-run-rules";
import { ensureOutsideMarker } from "./outside-marker";

export const ONE_IMPORT_RETIRED_KEY = "one-import:retired";
export const NOTICE_KEY_PREFIX = "first-run-notice:v2:";
const LAYOUT_KEY = "memory_layout";
const SPLIT_LAYOUT = "split-1";
const SWEPT_KEY = "drain_swept_revision";
/** The engine's own markers of step 5 (`first_run.py` META_CLASSIFIED / META_LLM): this file only READS them, from the root store the app already has open. */
export const CLASSIFIED_KEY = "first_run_classified";
export const LABELS_PROGRESS_KEY = "first_run_llm";
/** The open code that shows step 5b is not finished (the memory screen's status line prints it as it is). */
export const LABELS_PENDING_CODE = "first_run:labels_pending";
/** The model was asked as often as the engine allows and some lines are still where they were (defect 5): a state, not a stop, so it shows as its own code. */
export const LABELS_CAPPED_CODE = "first_run:labels_capped";
/** App-store meta key: the conductor still has step 5b to do although an end notice is written (defect 6). `firstRunLikelyPending` reads it so a live background service is handed over again. */
export const OPEN_WORK_KEY = "first-run-open:v1";
export const ROOT_MOVE_CODE = "first_run:root_move";
/**
 * DR-4b. The move cannot go on because no engine on this computer is new enough, and the engine updater is not on its way (its worker ended, or none can start: offline, refused, switched off).
 * Shows as the existing "Move paused" line with no reason sentence (the line never writes a code). It goes when an engine that can be asked is found, and the move goes on by itself:
 * the engine-detected signal (a worker ended, `current` or the updater's journal changed) looks again. Never shown while the worker runs or has not been started yet.
 */
export const ENGINE_WAIT_CODE = "first_run:engine_wait";
/** Asked again by the next signal (a wake from sleep, a chat, a runtime change) at least this long after the last attempt; no timer. */
export const ENGINE_UPDATE_RETRY_AFTER_MS = 10 * 60_000;
/** A stop made by an engine call this recent may be the engine being switched under it; the switch signal lifts it once. */
const ENGINE_SWITCH_STOP_WINDOW_MS = 120_000;
/** The longest command line one `reclassify` call may carry (Windows allows 32,767 characters in all). Past it the call is not made and the step stops with a code. */
const MAX_PROJECT_ARGS_CHARS = 24_000;
/** A guard against a loop that never settles: the most engine calls one app run makes (50,000 empty turns are about 30 calls). */
const MAX_ENGINE_CALLS_PER_RUN = 4_000;
/** `busy` / `locked` answers in a row before this run gives up on the step. */
const MAX_BUSY_IN_A_ROW = 6;
/** A stop caused by the engine on disk (not new enough, not found, not confirmed) is lifted by an engine-detected signal only after this long. */
const ENGINE_STOP_RELEASE_AFTER_MS = 30_000;
/** "Claude Code / Codex still open" is asked again by the next signal (a person's activity) at least this long after the last answer. No timer is set for it. */
export const OPEN_HOST_RETRY_AFTER_MS = 10 * 60_000;
/** A pass that calls the engine or imports rows waits until the person has not touched the machine for this long (the idle job's own "quiet" check). */
export const USER_IDLE_REQUIRED_SEC = 15;
/** Between two harness-table drops the event loop gets this long. */
const HARNESS_PAUSE_MS = 250;

export type StepId = "one-import" | "homes" | "copies" | "empty" | "tidy" | "tidy2" | "gather" | "classify" | "labels" | "move" | "rules" | "index" | "harness" | "notice";

/**
 * The steps the line's "n/total" counts, in the order the conductor reaches them for an account that has not finished (the end notice is the last). Counted from the conductor's own step ids, so the
 * total is what this code can really do: steps the start chain runs before the conductor (2, 3) and steps that run after the end notice (5b labels, 6c gathering, the late sweeps) are not in it.
 * A step that has nothing to do is passed over without a pass, so a screen may see the number jump; it never goes backwards for the same account except when the engine sends step 4 back.
 */
export const PROGRESS_STEPS: ReadonlyArray<StepId> = ["one-import", "copies", "empty", "tidy", "classify", "move", "tidy2", "rules", "index", "harness", "notice"];

/** The registry of the steps: who runs it, and what it needs. A step with `run: null` is a slot another package fills. */
export const STEPS: ReadonlyArray<{ number: string; id: string; owner: "desktop" | "engine" | "slot"; run: "conductor" | "start-chain" | null }> = [
  { number: "2", id: "agent-folders", owner: "desktop", run: "start-chain" },
  { number: "3", id: "experience-chips", owner: "desktop", run: "start-chain" },
  { number: "3'", id: "one-import", owner: "desktop", run: "conductor" },
  { number: "1", id: "engine-copies", owner: "engine", run: "conductor" },
  { number: "4", id: "empty-turns", owner: "engine", run: "conductor" },
  // (5a) After (3') (`one-import:retired` is set), before (6) when it can run, and also on a home where (6) is already done. The engine writes `first_run_classified` itself; this step never holds (6) back.
  // (4b) K5': engine `steps --only tidy`, before (6) (the queue of translations it deletes used to hold lines in the root) and once more after (6) (sub-stores exist then): units in the engine's first_run_tidy.py.
  { number: "4b", id: "tidy", owner: "engine", run: "conductor" },
  { number: "5a", id: "classify", owner: "engine", run: "conductor" },
  { number: "6", id: "memory-move", owner: "engine", run: "conductor" },
  // (6b) After (6) is complete for this account, before (7), (h) and the end notice. Writes ONE root meta row (first-run-rules.ts); copies and moves nothing; never writes the owner's rules file.
  { number: "6b", id: "workspace-rules", owner: "desktop", run: "conductor" },
  { number: "7", id: "session-and-code-index", owner: "desktop", run: "conductor" },
  { number: "h", id: "harness-cleanup", owner: "desktop", run: "conductor" },
  { number: "8", id: "end-notice", owner: "desktop", run: "conductor" },
  // (5b) The last: it does not hold (6), (7), (h) or (8) back and runs on after the end notice until the engine's key says done or capped. The model call is the desktop's, the lines are the engine's.
  { number: "5b", id: "classify-labels", owner: "desktop", run: "conductor" },
  // (6c) K5': the one long first gathering. It only ARMS the existing gathering (app meta `memory_gather_since` = the earliest instant); the resting-time gathering of K3' then reads the old turn records, two calls a pass, whenever a model is connected.
  { number: "6c", id: "first-gathering", owner: "desktop", run: "conductor" },
];

// --- notices ----------------------------------------------------------------------------------------------------------------------

export type NoticeCode = "host_plugin_restart" | "host_plugin_manual" | "disk_low" | "done";
export interface NoticeInput { code: NoticeCode; accountKey: string; /** O61: how many unread old memories (Hub drawers, Hub lines, removed agents) were deleted; said in the end notice when above 0. */ removed?: number; /** The switch was turned on in this run and the pick list has a candidate line: the end notice carries one more line (design P 5.6). */ rulesPick?: true }
/** The sentences, Korean and English together (the only new text of this package). */
export function noticeText(input: NoticeInput, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  switch (input.code) {
    // What an old plugin copy means for the person (it steps aside and uses no memory until it is new) and the one thing that ends it.
    case "host_plugin_restart": return ko ? "Claude Code·Codex를 닫았다 다시 열어 주세요. 그 전까지 그 창에서는 Agentlas 기억을 쓰지 않아요." : "Close and reopen Claude Code and Codex. Until then, Agentlas memory is not used there.";
    case "host_plugin_manual": return ko ? "Claude Code·Codex의 Agentlas 플러그인이 옛 버전이에요. agentlas.cloud/docs/agentlas-os/install 의 설치 명령으로 업데이트하면 그 창에서도 기억을 써요." : "The Agentlas plugin in Claude Code or Codex is out of date. Update it with the install command at agentlas.cloud/docs/agentlas-os/install to use memory there.";
    case "disk_low": return ko ? "디스크 여유가 부족해 기억 정리를 미뤘습니다." : "Memory cleanup is waiting for free disk space.";
    // No counts: this run only knows what it did itself, and a number that leaves out an earlier run (a restart, the wait for Claude Code) would be wrong.
    case "done": {
      const removed = input.removed && input.removed > 0 ? (ko ? ` · 아무도 읽지 않던 옛 기억 ${input.removed}개를 지웠어요` : ` · Deleted ${input.removed} old memories nobody read`) : "";
      return (ko ? (input.rulesPick ? "정리 끝 · 예전 지시를 '내 규칙'에 넣을 수 있어요" : "정리 끝") : (input.rulesPick ? "Cleanup finished · You can add earlier instructions to My rules" : "Cleanup finished")) + removed;
    }
  }
}

function defaultNotify(input: NoticeInput): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Notification } = require("electron") as typeof import("electron");
    if (!Notification?.isSupported?.()) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { currentUiLocale } = require("../ui-locale") as typeof import("../ui-locale");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { retainNotification } = require("../notification-target") as typeof import("../notification-target");
    retainNotification(new Notification({ title: "Agentlas", body: noticeText(input, currentUiLocale()), silent: true })).show();
  } catch { /* a notice that cannot be shown is not a failure of the migration */ }
}

// --- state (memory only: a restart derives everything from the markers again) -----------------------------------------------------

interface AccountRun {
  key: string;
  store8: string;
  /** `retryable`: the engine said asking again can change the cause (step 6 `no_progress`): lifted by the bounded waits like a transient stop. */
  stopped: Map<string, { code: string; at: number; retryable?: boolean }>;
  done: Set<string>;
  copiesRan: boolean;
  /** What step 1 told the person to do (`host_plugin_restart` / `host_plugin_manual`), so step 6's `engines_not_confirmed` repeats the same guidance, not another. */
  copiesCode: "host_plugin_restart" | "host_plugin_manual" | null;
  counts: { folders: number; rows: number; turns: number; removed: number };
  /** A call of this run deleted or moved rows: the one VACUUM at quit is worth asking for. */
  wrote: boolean;
  busyInARow: number;
  /** The finished home's late-rows look was made (once per app start and after an agent folder moved). */
  lateChecked: boolean;
  /** Step 5 was seen finished (5a's marker set and 5b's key done / capped) in this run: both only ever move forward, so the two keys are not read again (each read of the root store also re-checks its owner). */
  classificationFinished: boolean;
  /** Step 5b in this run (tests and the quit log read it; nothing is stored): batches applied, lines changed, model calls made, engine calls that carried a model's answer. */
  labels: { batches: number; applied: number; kept: number; modelCalls: number };
  /** Every engine copy on this computer was seen to declare the layout in this run (step 1 answered `done`, or the step `rules` asked and got `done`): the step `rules` does not ask again. */
  copiesDone: boolean;
  /** The switch row was seen `on` in this run (it only moves forward in a run; `turnWorkspaceRulesOff` is not the conductor's): the finished home's look at it is one read, once. */
  rulesOn: boolean;
  /** The step turned the switch on in this run and the pick list has a candidate line (the end notice says so). */
  rulesPick: boolean;
  /** Audit 62 (first run B6): how many times a stop whose cause ends by itself was lifted and asked again in this run (per step), against `IDLE_JOB_FAILURE_WAITS_MS`. */
  retries: Map<string, number>;
  /** Audit 62 (first run B4): how many times step 6 sent step 4 back because empty turn records appeared after it was done. */
  emptyRedo: number;
  /** Audit 62 (first run D7): the open code that says why step 1 did not finish (offline, updater failed), so it can be taken back. */
  copiesNote: string | null;
  /** K5': `memory_gather_since` was seen armed (earliest instant) / the old turn records were seen all read, in this run. */
  gatherArmed: boolean;
  gatherFinished: boolean;
  /**
   * BB-1a: the totals of the runs before this one (`first-run-counts:v1:<account>` in the app meta), so `counts` above (this run only; the end notice keeps reading it) plus `carry` is the whole move.
   * `countsTrusted` false = the row cannot be a whole move's total (the move had already started under a build that kept none): nothing is written and the screen gets no numbers. `savedCounts` = the last text written.
   */
  carry: { folders: number; rows: number; removed: number };
  countsTrusted: boolean;
  savedCounts: string | null;
}
interface Run {
  signal?: AbortSignal;
  job: IdleJob | null;
  offs: Array<() => void>;
  legacy: { homeMove: HomeMoveReport | null; chips: ChipAbsorbResult | null } | null;
  account: AccountRun | null;
  /** Earliest time the next pass may start (the pause between two engine calls). 0 = now. */
  notBefore: number;
  homesStale: boolean;
  calls: number;
  releaseMove: (() => void) | null;
  notified: Set<string>;
  selfReset: boolean;
  /** Step 7 is device-level (the projects are the device's, not an account's): done / stopped once per app start, whatever account is current. */
  index: { done: boolean; stop: string | null; stopAt?: number; retries?: number; last?: string; same?: number };
  /** The open-work marker was brought up to date for the finished account in this run. */
  openWorkSynced: boolean;
  /** DR-4b: what the last `pickStep` already read (no read of its own is added): the end notice, the retired One drawer, the layout. Null = it stopped before reading them. */
  look: { noticed: boolean; retired: boolean; layout: string | null } | null;
}
let run: Run | null = null;

export interface FirstRunHooks {
  runner?: EngineRunner;
  probe?: () => EngineProbe;
  notify?: (input: NoticeInput) => void;
  now?: () => number;
  /** Replaces the full home move pass the conductor repeats after an agent folder moved. */
  rerunHomeMove?: (signal?: AbortSignal) => Promise<HomeMoveReport | null>;
  /** Replaces the root and app stores (a test with the real ones leaves this alone). */
  oneImport?: () => Promise<{ reason?: string; retryable: boolean }>;
  /** Seconds since the person last touched the machine (the real one is the OS idle time). */
  idleSeconds?: () => number;
  /** Replaces OPEN_HOST_RETRY_AFTER_MS. */
  openHostRetryAfterMs?: number;
  /** Replaces the agent-folder root move check (the journal file and the in-process state). */
  rootMoveOpen?: () => boolean;
  /** Replaces `removedAgentIds` (the agents the app says are removed,). */
  removedAgents?: () => RemovedAgentsPlan;
  /** Replaces the registered projects handed to `reclassify`. */
  projects?: () => ReadonlyArray<{ id: string; name: string; folderPath: string | null }>;
  /** DR-4b: what became of the engine updater (the real one reads hephaestus/engine.ts `hephaestusUpdaterOutlook`). */
  updaterOutlook?: () => "pending" | "running" | "gave_up";
  /** DR-4b: start the engine updater once more (the real one is `startHephaestusRuntimeAutoUpdate`). */
  rearmUpdater?: () => void;
  /** Replaces the route and the model of step 5b (the engine side stays the `runner`). */
  labels?: Pick<LabelDeps, "route" | "model">;
  /** Replaces `relocateProjectIndexesOnce` (step 7). */
  relocate?: (options: { signal?: AbortSignal; limit: number }) => Promise<{ state: string; done: boolean; remaining: number; failed: number }>;
}
let hooks: FirstRunHooks = {};
/** Test seam: replaces the engine runner, the engine probe, the notice sink and the clock. `{}` restores the real ones. */
export function setFirstRunHooksForTests(next: FirstRunHooks): void { hooks = next; }
const now = (): number => (hooks.now ?? Date.now)();
const runner = (): EngineRunner => hooks.runner ?? (hooks.runner = createEngineRunner());
const probe = (): EngineProbe => {
  if (hooks.probe) return hooks.probe();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hephaestusRoot } = require("../hephaestus/engine") as typeof import("../hephaestus/engine");
  return probeEngineRoot(hephaestusRoot());
};

// --- reads (cheap: a few single-row selects, no process, no write) ----------------------------------------------------------------

function appDb(): import("better-sqlite3").Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("../store/db") as typeof import("../store/db")).getDb();
}
function rootDb(): import("better-sqlite3").Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("../memory/database") as typeof import("../memory/database")).getMemoryDb() as unknown as import("better-sqlite3").Database;
}
function readRootMeta(key: string): string | null {
  const row = rootDb().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(key) as { value: unknown } | undefined;
  return row === undefined || row.value === null || row.value === undefined ? null : String(row.value);
}
function writeRootMeta(key: string, value: string): void {
  rootDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function readAppMeta(key: string): string | null {
  const row = appDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeAppMeta(key: string, value: string): void {
  appDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
function ownerRole(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("../store/db") as typeof import("../store/db")).openedStoreMigrationRole();
}
/** Step 5's two markers in ONE statement (the engine's `first_run_classified` and the progress key `first_run_llm`; this is the whole cost of looking at a finished home for step 5). */
function readClassifyMarks(): { classified: boolean; llmState: string | null } {
  const row = rootDb().prepare("SELECT (SELECT 1 FROM memory_store_meta WHERE key=?) AS classified, (SELECT value FROM memory_store_meta WHERE key=?) AS llm").get(CLASSIFIED_KEY, LABELS_PROGRESS_KEY) as { classified: unknown; llm: unknown } | undefined;
  let llmState: string | null = null;
  try {
    const parsed = row?.llm === null || row?.llm === undefined ? null : JSON.parse(String(row.llm)) as { state?: unknown } | null;
    if (parsed && typeof parsed.state === "string") llmState = parsed.state;
  } catch { llmState = null; }
  return { classified: row?.classified !== null && row?.classified !== undefined, llmState };
}
/** An agent-folder root move that has not finished: running in this process, or a journal on disk that is not yet committed (agents/root-move.ts). Reads one small file. Never throws. */
export function rootMoveOpen(): boolean {
  if (hooks.rootMoveOpen) return hooks.rootMoveOpen();
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const move = require("../agents/root-move") as typeof import("../agents/root-move");
    if (move.agentRootMoveActive()) return true;
    // Audit 62 (first run D5): a journal whose writer is gone is settled by the question itself (rolled back or finished), so a move that died or whose last write failed no longer shows as "open" until an owner-role start.
    try { move.agentRootMoveBusy(); } catch { /* the file read below still answers */ }
    const { agentlasHomeDir } = require("../agents/home") as typeof import("../agents/home");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    /* eslint-enable @typescript-eslint/no-require-imports */
    let text: string;
    try { text = fs.readFileSync(path.join(agentlasHomeDir(), move.ROOT_MOVE_JOURNAL), "utf8"); } catch { return false; }   // no journal (or not readable): not moving
    const journal = JSON.parse(text.replace(/^\uFEFF/, "")) as { phase?: unknown; finished?: unknown };
    // planned / copied / committing are open; a committed move whose own finishing (routes, plan paths) is not done is open too. A committed and finished journal only waits for the old root's retirement.
    return journal.phase === "planned" || journal.phase === "copied" || journal.phase === "committing" || (journal.phase === "committed" && journal.finished !== true);
  } catch { return false; }
}
function accountIdentity(): { key: string; store8: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const namespace = (require("../memory/database") as typeof import("../memory/database")).activeMemoryOwnerNamespace();
    const hex = crypto.createHash("sha256").update(namespace, "utf8").digest("hex");
    return { key: hex.slice(0, 16), store8: hex.slice(0, 8) };
  } catch { return null; }
}
/**
 * BB-1a: what the earlier runs of this move counted. A row written by this code is a whole total; no row on an account whose move has not begun (the One drawer is not retired yet) starts one from zero; no row on an
 * account whose move had begun under an older build cannot be completed, so nothing is kept for it (the window then names the rows without numbers). Never throws.
 */
function loadCarry(key: string): { carry: AccountRun["carry"]; countsTrusted: boolean; savedCounts: string | null } {
  const zero = { folders: 0, rows: 0, removed: 0 };
  try {
    const text = readAppMeta(FIRST_RUN_COUNTS_KEY_PREFIX + key);
    if (text !== null) {
      const parsed = JSON.parse(text) as Record<string, unknown> | null;
      const n = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
      return { carry: { folders: n(parsed?.agents), rows: n(parsed?.memory), removed: n(parsed?.removed) }, countsTrusted: true, savedCounts: text };
    }
    return { carry: zero, countsTrusted: readRootMeta(ONE_IMPORT_RETIRED_KEY) === null && readAppMeta(NOTICE_KEY_PREFIX + key) === null, savedCounts: null };
  } catch { return { carry: zero, countsTrusted: false, savedCounts: null }; }
}
/** Writes the move's totals (carry + this run) when they changed since the last write; `force` writes even zeros (the end: a row that says "nothing counted" keeps the window from naming rows it has no number for). Never throws. */
function persistCounts(account: AccountRun, force = false): void {
  if (!account.countsTrusted) return;
  try {
    const total = { agents: account.carry.folders + account.counts.folders, memory: account.carry.rows + account.counts.rows, removed: account.carry.removed + account.counts.removed };
    if (!force && total.agents + total.memory + total.removed === 0 && account.savedCounts === null) return;
    const text = JSON.stringify(total);
    if (text === account.savedCounts) return;
    writeAppMeta(FIRST_RUN_COUNTS_KEY_PREFIX + account.key, text);
    account.savedCounts = text;
  } catch { /* the next pass writes it again */ }
}

function accountRun(identity: { key: string; store8: string }): AccountRun {
  const current = run!;
  if (current.account?.key === identity.key) return current.account;
  // The account changed (or this is the first look): what this run learned about another account's root does not apply.
  current.account = { key: identity.key, store8: identity.store8, stopped: new Map(), done: new Set(), copiesRan: false, copiesCode: null, counts: { folders: 0, rows: 0, turns: 0, removed: 0 }, wrote: false, busyInARow: 0, lateChecked: false, classificationFinished: false, labels: { batches: 0, applied: 0, kept: 0, modelCalls: 0 }, copiesDone: false, rulesOn: false, rulesPick: false, retries: new Map(), emptyRedo: 0, copiesNote: null, gatherArmed: false, gatherFinished: false, ...loadCarry(identity.key) };
  setFirstRunStep(null);   // another account: the step of the one before is not this one's
  return current.account;
}
function revisionOf(): string {
  const value = readRootMeta("revision");
  return String(Number(value ?? 0) || 0);
}
const homesRan = (): boolean => run?.legacy?.homeMove != null && !run.legacy.homeMove.skipped;

/**
 * How long until the person has been away long enough for a pass (0 = now). Both the engine calls and the One drawer import hold the memory store for
 * a moment, so no pass starts while the person is typing; the idle job aims its next look at the moment the guard could pass and backs off after that.
 * Where the OS cannot say (no power monitor), the guard does not hold the migration back.
 */
export function userIdleWaitMs(): number {
  let idle = Number.POSITIVE_INFINITY;
  try {
    if (hooks.idleSeconds) idle = hooks.idleSeconds();
    else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { powerMonitor } = require("electron") as typeof import("electron");
      const seconds = powerMonitor.getSystemIdleTime();
      if (typeof seconds === "number" && Number.isFinite(seconds)) idle = seconds;
    }
  } catch { /* unknown: not held back */ }
  return idle < USER_IDLE_REQUIRED_SEC ? Math.max(1_000, (USER_IDLE_REQUIRED_SEC - idle) * 1_000) : 0;
}

/** The steps that call the engine (or, for 5b, the engine and a model): none of them starts while an agent-folder root move is open. */
const ENGINE_LIKE: ReadonlySet<StepId> = new Set(["copies", "empty", "tidy", "tidy2", "classify", "labels", "move", "homes", "index", "rules"]);

/** What the next pass would do, from reads only. `null` step = nothing runnable now (done, waiting for a signal, or stopped for this run). */
export function decide(): { step: StepId | null; account: AccountRun | null } {
  // The whole look is synchronous reads: the account marker is read once for it, not once per statement (memory/database.ts withOwnerNamespaceSpan).
  let span: (<R>(fn: () => R) => R) | null = null;
  try { span = (require("../memory/database") as typeof import("../memory/database")).withOwnerNamespaceSpan; } catch { span = null; }   // eslint-disable-line @typescript-eslint/no-require-imports -- lazy like the other reads here; a host with no memory module reads as before
  return span ? span(decideLook) : decideLook();
}
function decideLook(): { step: StepId | null; account: AccountRun | null } {
  const picked = pickStep();
  syncEngineWait(picked);
  if (!picked.step || !ENGINE_LIKE.has(picked.step)) { if (picked.step) clearFirstRunOpenCode(ROOT_MOVE_CODE); return picked; }
  // A root move is open: no engine step starts; the code shows and the next signal (any chat, runtime or agent change, a freed run slot, a wake from sleep) looks again.
  if (rootMoveOpen()) { noteFirstRunOpenCode(ROOT_MOVE_CODE); return { step: null, account: picked.account }; }
  clearFirstRunOpenCode(ROOT_MOVE_CODE);
  return picked;
}

// --- DR-4b: the move waits for an engine, and says so --------------------------------------------------------------------------
let engineWaitSince = 0;
const updaterOutlook = (): "pending" | "running" | "gave_up" => {
  if (hooks.updaterOutlook) return hooks.updaterOutlook();
  try { return (require("../hephaestus/engine") as typeof import("../hephaestus/engine")).hephaestusUpdaterOutlook(); } catch { return "pending"; }   // eslint-disable-line @typescript-eslint/no-require-imports
};
function rearmUpdater(): void {
  if (hooks.rearmUpdater) { hooks.rearmUpdater(); return; }
  void import("../hephaestus/engine").then((engine) => engine.startHephaestusRuntimeAutoUpdate()).catch(() => undefined);
}
/** Reads no store (what the look just read is in `run.look`). The engine steps (1, 4, 4b, 6) cannot be asked while no engine that declares the layout exists and the layout is not the new one yet. */
function engineHoldsTheMove(account: AccountRun | null): boolean {
  const look = run?.look;
  if (!account || !run?.legacy || !look || look.noticed || !look.retired || look.layout !== null) return false;
  return !probe().capable;
}
/**
 * The code is set only when the updater has nothing more coming (`gave_up`); while it runs or has not started the line says what it always said. A signal that finds it still gone, at least
 * ENGINE_UPDATE_RETRY_AFTER_MS after the last attempt, starts the updater once more (the network may be back; the person's chat or the machine's wake is the signal, never a timer).
 */
function syncEngineWait(picked: { step: StepId | null; account: AccountRun | null }): void {
  if (picked.step || !engineHoldsTheMove(picked.account)) { engineWaitSince = 0; clearFirstRunOpenCode(ENGINE_WAIT_CODE); return; }
  if (updaterOutlook() !== "gave_up") { clearFirstRunOpenCode(ENGINE_WAIT_CODE); return; }
  noteFirstRunOpenCode(ENGINE_WAIT_CODE);
  const t = now();
  if (engineWaitSince === 0) engineWaitSince = t;
  else if (t - engineWaitSince >= ENGINE_UPDATE_RETRY_AFTER_MS) { engineWaitSince = t; rearmUpdater(); }
}

/** Step 5's next unit for a home that has a retired One drawer: 5a while `first_run_classified` is not set, then 5b while the progress key is not done / capped. Reads only. */
function classificationStep(account: AccountRun): "classify" | "labels" | null {
  if (!run?.legacy || account.classificationFinished) return null;
  // An engine from before step 5 answers none of its commands (two file reads, no process, no store read): nothing is called and nothing is shown; the signal that an engine was detected again looks once more.
  if (!probe().classifyCapable) return null;
  const marks = readClassifyMarks();
  const labelsFinished = marks.llmState === "done" || marks.llmState === "capped" || account.done.has("labels");
  if (marks.classified && labelsFinished) {
    account.classificationFinished = true; clearFirstRunOpenCode(LABELS_PENDING_CODE);
    // `capped` is final and some lines stayed where they were: it is shown, never silent (defect 5).
    if (marks.llmState === "capped") noteFirstRunOpenCode(LABELS_CAPPED_CODE);
    setOpenWork(rulesStillOwed());
    return null;
  }
  if (!marks.classified) return account.done.has("classify") || account.stopped.has("classify") ? null : "classify";
  noteFirstRunOpenCode(LABELS_PENDING_CODE);
  // 5b changes nothing before the split layout is on (defect 3): a copy of the engine without the reading range may still be open in a Claude Code or Codex window.
  if (readRootMeta(LAYOUT_KEY) !== SPLIT_LAYOUT) return null;
  return account.stopped.has("labels") ? null : "labels";
}

/** The move is complete for this account (its answer was `done`, the root was swept at this revision, or it settled as `partial`). Reads only. */
function moveSettled(account: AccountRun): boolean {
  return account.done.has("move") || readRootMeta(SWEPT_KEY) === revisionOf() || movePartialSettled(account);
}
/** Step 4b after the move: once per app run, by an engine that has the step. A stop of it is its own. */
function tidyDue(account: AccountRun): boolean {
  if (account.done.has("tidy2") || account.stopped.has("tidy2")) return false;
  const engine = probe();
  return Boolean(engine.capable && engine.tidyCapable);
}
/** K5' step 6c. The earliest instant: every turn record is "after" it, so the resting-time gathering reads the old ones too. */
export const GATHER_SINCE_KEY = "memory_gather_since";
export const GATHER_EPOCH = "1970-01-01T00:00:00.000Z";
/**
 * How many days of old turn records the one long first gathering reads: `null` = all of them (the earliest instant). THE ONE PLACE this range is set.
 * 정한 값 — 오너 판정 대기 (decided: nothing yet; the owner was asked). Reading all of them costs one model call per 32 turn records (about 335 calls for the 10,692 records measured on the owner's Mac, taken from the
 * connected model/subscription); a number of days reads only the records written in the last N days and leaves the older ones as they are (they are never read: `memory_gather_since` is a start, not a list).
 * What a change does when reached: nothing is deleted either way; a smaller N means fewer calls and the older records stay unread turn records until the 30-day empty-turn rule or the forget path takes them.
 */
export const GATHER_FIRST_READ_DAYS: number | null = null;
/** The `since` the gathering is armed with: the earliest instant, or N days before `at`. */
export function gatherSinceValue(at: number = Date.now()): string {
  return GATHER_FIRST_READ_DAYS === null ? GATHER_EPOCH : new Date(at - GATHER_FIRST_READ_DAYS * 86_400_000).toISOString();
}
export const GATHER_PENDING_CODE = "first_run:gather_pending";
/** `gather` to arm it, `null` when it is armed (watching: the open code shows while old turn records wait, and goes when none is left) or not yet its turn. Reads only except nothing: arming is `runGatherStep`. */
function gatherLook(account: AccountRun): StepId | null {
  if (account.gatherFinished) return null;
  if (!account.done.has("tidy2") && !account.stopped.has("tidy2") && tidyDue(account)) return null;   // the tidy goes first (its queue and receipts are gone before the old records are read)
  if (!account.gatherArmed) {
    const armedAt = readAppMeta(GATHER_SINCE_KEY);
    if (armedAt !== null && armedAt <= gatherSinceValue(now())) account.gatherArmed = true;   // the gathering keeps its `since` in the APP meta (store/meta), not in the memory root
    else return account.stopped.has("gather") ? null : "gather";
  }
  let pending = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pending = (require("../memory/gathering") as typeof import("../memory/gathering")).gatherDueState({ since: gatherSinceValue(now()) }).pending;
  } catch { return null; }
  if (pending > 0) { noteFirstRunOpenCode(GATHER_PENDING_CODE); return null; }
  clearFirstRunOpenCode(GATHER_PENDING_CODE);
  account.gatherFinished = true;
  return null;
}

function pickStep(): { step: StepId | null; account: AccountRun | null } {
  const idle = { step: null, account: null };
  if (run) run.look = null;
  if (!run || !firstRunMigrationEnabled() || run.signal?.aborted) return idle;
  const identity = accountIdentity();
  if (!identity) return idle;
  const account = accountRun(identity);
  const finished = { step: null, account };
  if (ownerRole() !== "owner") return idle;
  liftOpenHostStops(account);
  liftTimedStops(account);
  if (readAppMeta(NOTICE_KEY_PREFIX + identity.key) !== null) {
    run.look = { noticed: true, retired: true, layout: null };
    // A finished account: rows that reached the root after the end notice (an agent whose folder moved later, a window still on an older engine) are swept
    // once per app start / folder move, and only when the root's revision moved since its last sweep (two more reads; no engine process otherwise).
    if (!run.openWorkSynced) { run.openWorkSynced = true; syncOpenWork(); }
    if (lateRowsWaiting(account)) return { step: "move", account };
    // A home whose end notice was written before the step `rules` existed (or while it waited for an old engine copy): the switch is still owed.
    if (rulesDue(account)) return { step: "rules", account };
    // A home that finished before step 5 could run (the end notice is written first, defect C): 5a and 5b still run, and step 7 once per app start.
    const late = classificationStep(account);
    if (late) return { step: late, account };
    if (readRootMeta(LAYOUT_KEY) === SPLIT_LAYOUT && tidyDue(account)) return { step: "tidy2", account };
    const gatheringLate = readRootMeta(LAYOUT_KEY) === SPLIT_LAYOUT ? gatherLook(account) : null;
    if (gatheringLate) return { step: gatheringLate, account };
    if (!run.index.done && !run.index.stop && readRootMeta(LAYOUT_KEY) === SPLIT_LAYOUT) return { step: "index", account };
    return finished;
  }
  if (!run.legacy) return finished;                                          // (2) and (3) are still in the start chain
  if (run.calls >= MAX_ENGINE_CALLS_PER_RUN) return finished;
  const stopped = (id: string): boolean => account.stopped.has(id);
  const retired = readRootMeta(ONE_IMPORT_RETIRED_KEY) !== null;
  if (!retired && !stopped("one-import")) return { step: "one-import", account };

  const layout = readRootMeta(LAYOUT_KEY);
  run.look = { noticed: false, retired, layout };
  const split = layout === SPLIT_LAYOUT;
  const layoutKnown = layout === null || split;
  const engine = layoutKnown && !split ? probe() : { hasSteps: false, memoryLayout: null, capable: false };
  if (!split && layoutKnown) {
    if (engine.hasSteps && !account.copiesRan && !stopped("copies")) return { step: "copies", account };
    if (engine.capable && !account.done.has("empty") && !stopped("empty")) return { step: "empty", account };
    if (engine.capable && engine.tidyCapable && account.done.has("empty") && !account.done.has("tidy") && !stopped("tidy")) return { step: "tidy", account };
  }
  // (5a) after (3') and before (6) whenever it can run; a stop of 5a (engine without the command, a busy store, a full disk) is its own and does not hold (6) back. 5b waits for the end of the list below.
  const classification = retired ? classificationStep(account) : null;
  if (classification === "classify") return { step: "classify", account };
  if (retired && layoutKnown && !stopped("move") && !account.done.has("move")) {
    if (split) {
      // Already on the new layout: ask the engine only when the root holds something it has not swept since its revision last changed.
      if (readRootMeta(SWEPT_KEY) !== revisionOf() && probe().capable) return { step: "move", account };
    } else if (engine.capable && account.done.has("empty")) {
      if (homesRan()) return { step: "move", account };
      if (run.homesStale && !stopped("homes")) return { step: "homes", account };
    }
  }
  // (4b) again, after (6): sub-stores exist now (the two columns, the vectors) and whatever the move brought into the root.
  if (retired && split && moveSettled(account) && tidyDue(account)) return { step: "tidy2", account };
  // (6b) the move is complete for this account: the workspace-rules switch (first-run-rules.ts). Before (7), (h) and the end notice, so a live background service cannot keep the account out of it.
  if (retired && split && rulesDue(account)) return { step: "rules", account };
  // (7) the layout is written: the old code-map folders move to their new place (lstat only when none is left); stopped or done for this run, it never holds the harness step or the notice back.
  if (split && !run.index.done && !run.index.stop) return { step: "index", account };
  if (harnessWorkLeft(appDb()) && !stopped("harness")) return { step: "harness", account };
  // The end: only when the move really is complete (the layout is on and swept, or this run's last call said done) and nothing else is open. Step 5b does not wait for it.
  // Audit 62 (first run B3, B11): a notice that already failed is not picked again by the same look (its stop is read), and a move that did what it could and says `partial` (some line can never go) lets the end be written
  // without the "finished" notification (`runNoticeStep`): one stuck line no longer holds the end back for ever.
  const gathering = retired && split && moveSettled(account) ? gatherLook(account) : null;
  if (gathering) return { step: gathering, account };
  if (retired && split && !stopped("notice") && (account.done.has("move") || readRootMeta(SWEPT_KEY) === revisionOf() || movePartialSettled(account)) && !harnessWorkLeft(appDb()) && !rulesHoldsNotice(account)) return { step: "notice", account };
  if (classification === "labels") return { step: "labels", account };
  return finished;
}

/** a stop for "Claude Code / Codex still open" is lifted by the next signal once the last answer is old enough (decide only runs on a signal or a look). */
function liftOpenHostStops(account: AccountRun): void {
  for (const [step, info] of [...account.stopped]) {
    if (!/engines_not_confirmed|rules\/engine_no_answer/.test(info.code) || now() - info.at < (hooks.openHostRetryAfterMs ?? OPEN_HOST_RETRY_AFTER_MS)) continue;
    releaseStop(account, step);
    // The copy on disk is switched by the installed engine's updater once the host program has closed (step 1), so it is asked again too (still at most once per signal).
    account.copiesRan = false;
  }
}

/** Audit 62 (first run B11): the engine moved what it could and some line cannot move (`remaining/partial`): for this run that is as far as the move goes. */
function movePartialSettled(account: AccountRun): boolean { return account.stopped.get("move")?.code === "remaining/partial"; }

/**
 * Audit 62 (first run B6, D1, D2, D3, D4, D8): a stop is for the rest of the run, but a stop whose cause ends by itself (a store or the engine held for a moment, an engine that gave no answer, a model that failed once,
 * a full disk that was emptied, a drive that came back, an app database that could not be written, Claude Code still open) must not wait for a restart that may be days away: the app stays open for days.
 * It is lifted and asked again after the idle job's own failure waits (5 minutes, 30 minutes, 2 hours: `IDLE_JOB_FAILURE_WAITS_MS`), three times at most in a run, and then it stays (the code keeps showing).
 * The first wait of "Claude Code / Codex still open" is the 10 minutes of. No poll: `dueAt` aims the idle job's one timer at the earliest lift time, and only while such a stop exists.
 * A cause that does not end by itself (`partial`, `no_progress`, `engine_not_capable`, a model not connected, an engine on disk that is too old) is not in the list; those have their own signals.
 */
const TRANSIENT_STOP = /^(?:remaining\/(?:busy|locked|disk_low|disk_full)|deferred\/locked|failed\/(?:no_answer|exception|[A-Z][A-Za-z0-9]{1,60})|labels\/(?:no_answer|no_usable_answer|exception|external)|rules\/engine_no_answer|index\/(?:busy|exception)|root-[a-z-]+|failed)$/;
const HOST_OPEN_STOP = /engines_not_confirmed|rules\/engine_no_answer/;
function liftWaitMs(code: string, retries: number, retryable?: boolean): number | null {
  if (retryable) return IDLE_JOB_FAILURE_WAITS_MS[retries] ?? null;   // the engine said asking again can change it (step 6 `no_progress`): the same three bounded waits, then it stays
  if (HOST_OPEN_STOP.test(code)) { const waits = [hooks.openHostRetryAfterMs ?? OPEN_HOST_RETRY_AFTER_MS, ...IDLE_JOB_FAILURE_WAITS_MS.slice(1)]; return waits[retries] ?? null; }
  if (!TRANSIENT_STOP.test(code)) return null;
  return IDLE_JOB_FAILURE_WAITS_MS[retries] ?? null;
}
function liftTimedStops(account: AccountRun): void {
  for (const [step, info] of [...account.stopped]) {
    const retries = account.retries.get(step) ?? 0;
    const wait = liftWaitMs(info.code, retries, info.retryable);
    if (wait === null || now() - info.at < wait) continue;
    account.retries.set(step, retries + 1);
    releaseStop(account, step);
    if (step === "homes" && run) run.homesStale = true;   // the folder step is asked again by the conductor itself
    if (HOST_OPEN_STOP.test(info.code)) account.copiesRan = false;
  }
  const index = run?.index;
  if (index?.stop && index.stopAt !== undefined) {
    const retries = index.retries ?? 0;
    const wait = liftWaitMs(index.stop, retries);
    if (wait !== null && now() - index.stopAt >= wait) { index.retries = retries + 1; clearFirstRunOpenCode(stopCodeName(index.stop)); index.stop = null; index.same = 0; }
  }
}
/** When the earliest stop whose cause may end by itself is due to be lifted (ms since epoch), or null when there is none. */
function nextStopLiftAt(account: AccountRun | null): number | null {
  let earliest: number | null = null;
  const consider = (code: string, at: number, retries: number, retryable?: boolean): void => {
    const wait = liftWaitMs(code, retries, retryable);
    if (wait !== null) earliest = earliest === null ? at + wait : Math.min(earliest, at + wait);
  };
  if (account) for (const [step, info] of account.stopped) consider(info.code, info.at, account.retries.get(step) ?? 0, info.retryable);
  const index = run?.index;
  if (index?.stop && index.stopAt !== undefined) consider(index.stop, index.stopAt, index.retries ?? 0);
  return earliest;
}

/** The two root markers in ONE statement: when the engine last swept the root, and the root's revision now (each is the engine's / the store's own marker, no new key). */
function sweptAndRevision(): { swept: string | null; revision: string } {
  const row = rootDb().prepare("SELECT (SELECT value FROM memory_store_meta WHERE key=?) AS swept, (SELECT value FROM memory_store_meta WHERE key='revision') AS revision").get(SWEPT_KEY) as { swept: unknown; revision: unknown } | undefined;
  return { swept: row?.swept === null || row?.swept === undefined ? null : String(row.swept), revision: String(Number(row?.revision ?? 0) || 0) };
}

/**
 * Audit 48 defect 6. The end notice is written without waiting for 5b, and a start whose background service is alive makes Main a follower (no conductor) unless the service is
 * handed over; the hand-over decision (`start-guard.firstRunLikelyPending`) used to read "a notice exists" as "nothing is left". One app-store meta key says "5b is still to do":
 * written when the notice is, removed when 5b is final (done / capped) or the engine cannot do step 5 at all. Written and removed only on a change.
 */
function setOpenWork(open: boolean): void {
  try {
    const has = readAppMeta(OPEN_WORK_KEY) !== null;
    if (open && !has) writeAppMeta(OPEN_WORK_KEY, new Date(now()).toISOString());
    else if (!open && has) appDb().prepare("DELETE FROM meta WHERE key = ?").run(OPEN_WORK_KEY);
  } catch { /* the next look writes it again */ }
}
function syncOpenWork(): void {
  try {
    // The switch still owed to this account is open work whatever step 5 says (a step after the end notice is never reached by a start whose live service is not handed over).
    if (!probe().classifyCapable) { setOpenWork(rulesStillOwed()); return; }
    const marks = readClassifyMarks();
    // `waiting_model` (the engine was told no model is connected) is not open work: a marker that stays would hand the live service over at every start for as long as the user connects none (defect B).
    setOpenWork(!(marks.classified && (marks.llmState === "done" || marks.llmState === "capped" || marks.llmState === "waiting_model")) || rulesStillOwed());
  } catch { /* unknown: left as it is */ }
}
/**
 * The signal that a model may have become available (a runtime was connected, signed in or changed; no timer, no polling): while 5b waits for a model the marker is written again, so that the next start hands the
 * service over and 5b asks the model. The conductor calls it from its own runtime signal; a start that is a follower (the service owns the store, no conductor) subscribes to the same signal once.
 * One cheap read, a write only on a change; a model that cannot be reached makes 5b say `waiting_model` again, which removes the marker again.
 */
function reopenWorkAfterRuntimeChange(): void {
  try {
    if (!firstRunMigrationEnabled()) return;
    const marks = readClassifyMarks();
    if (marks.classified && marks.llmState === "waiting_model") setOpenWork(true);
  } catch { /* the next runtime change looks again */ }
}
let followerRuntimeWatch: (() => void) | null = null;

/** Once per app start and after an agent folder moved (not at every look): the finished home's steady-state cost stays what it was. */
function lateRowsWaiting(account: AccountRun): boolean {
  if (!run || account.lateChecked || account.stopped.has("move") || account.done.has("move") || run.calls >= MAX_ENGINE_CALLS_PER_RUN) return false;
  const marks = sweptAndRevision();
  // Nothing waiting: this look is done for this start. Something waiting: the flag is set when the sweep call is made (the idle job reads decide() twice: once to
  // see it is due, once to run it).
  const waiting = marks.swept !== marks.revision && readRootMeta(LAYOUT_KEY) === SPLIT_LAYOUT && probe().capable;
  if (!waiting) account.lateChecked = true;
  return waiting;
}

/** The step `rules` stops with these two codes while an engine copy is old or cannot be asked: a signal looks again (liftOpenHostStops), and the end notice waits for it like it waits for step 6. */
const RULES_HOLD_CODE = /^rules\/(?:engines_not_confirmed|engine_no_answer)$/;

/**
 * What the step `rules` decides from, in ONE statement: the layout, the retired One drawer, the two markers the end notice reads for "the move is complete" (`drain_swept_revision` = the root's revision),
 * and the switch row itself. No new marker: every one of them is written by someone else already ("first job").
 */
function readRulesMarks(): { layout: string | null; retired: boolean; swept: string | null; revision: string; on: boolean } {
  const row = rootDb().prepare("SELECT (SELECT value FROM memory_store_meta WHERE key=?) AS layout, (SELECT 1 FROM memory_store_meta WHERE key=?) AS retired, (SELECT value FROM memory_store_meta WHERE key=?) AS swept, (SELECT value FROM memory_store_meta WHERE key='revision') AS revision, (SELECT value FROM memory_store_meta WHERE key=?) AS rules")
    .get(LAYOUT_KEY, ONE_IMPORT_RETIRED_KEY, SWEPT_KEY, switchKey()) as { layout: unknown; retired: unknown; swept: unknown; revision: unknown; rules: unknown } | undefined;
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return { layout: text(row?.layout), retired: row?.retired !== null && row?.retired !== undefined, swept: text(row?.swept), revision: String(Number(row?.revision ?? 0) || 0), on: text(row?.rules) === "on" };
}

/**
 * Is the step `rules` due for this account? Reads only (but for the machine file of X1, written once when the switch is already on and the file is not there). All of: the One drawer is retired; the layout is `split-1`; the move is complete (the marker the end notice reads: this run's last move call said `done`, or
 * the engine swept the root at its present revision); the switch is not on yet; the step has not finished or stopped in this run. Seen `on` once, an account is not asked about it again in this run.
 */
function rulesDue(account: AccountRun): boolean {
  if (account.rulesOn || account.done.has("rules") || account.stopped.has("rules")) return false;
  const marks = readRulesMarks();
  if (marks.on) { if (ensureOutsideMarker() !== "failed") account.rulesOn = true; return false; }   // an account that turned the switch on before the marker existed gets it here; a failed write is looked at again
  if (!marks.retired || marks.layout !== SPLIT_LAYOUT) return false;
  return account.done.has("move") || (marks.swept !== null && marks.swept === marks.revision);
}

/** The step `rules` is waiting for an engine copy: the end notice does not say "finished" over it (the same as step 6), and a signal lifts it. */
function rulesHoldsNotice(account: AccountRun): boolean {
  const info = account.stopped.get("rules");
  return !!info && RULES_HOLD_CODE.test(info.code);
}

/**
 * Is the switch still owed to this account, whatever this run does? The switch is not on, the layout is `split-1` and this build's ruleset copy can carry it. Feeds the open-work marker: a start whose background
 * service is alive hands the service over while it is true, so an account that finished before the step existed (or whose step is waiting for an old Claude Code window) is not left out. A ruleset copy that cannot
 * carry the switch can never finish, so it is not open work (defect B: no marker for a state that cannot end). Never throws.
 */
function rulesStillOwed(): boolean {
  try {
    // Audit 62 (first run B11): a move that stopped on `partial` never completes in this run, so the switch (which needs a complete move) cannot be turned on: not open work (a marker for a state that cannot end hands the service over at every start).
    if (run?.account && movePartialSettled(run.account)) return false;
    const marks = readRulesMarks();
    return !marks.on && marks.retired && marks.layout === SPLIT_LAYOUT && rulesetCarriesSwitch();
  } catch { return false; }
}

/**
 * D5 (trial): a look (`decide`, `dueAt`) that cannot read the stores used to leave one log line and nothing else; the conductor then sat still with no code on the screen.
 * The error's machine word (an Error `code`, or a message that is itself a machine word such as `memory_migration_source_collision`) is now the open code
 * `first_run:look_failed/<word>` (`look_failed/unknown` for anything else); it is dropped by the next look that reads fine. One code at a time, in memory only.
 */
const LOOK_WORD = /^[a-z][a-z0-9_]{0,59}$/;
let lookFailureCode: string | null = null;
function noteLookFailure(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code, message = error instanceof Error ? error.message : "";
  const word = typeof code === "string" && LOOK_WORD.test(code) ? code : LOOK_WORD.test(message) ? message : "unknown";
  const next = `first_run:look_failed/${word}`;
  if (lookFailureCode && lookFailureCode !== next) clearFirstRunOpenCode(lookFailureCode);
  lookFailureCode = next;
  noteFirstRunOpenCode(next);
}
function clearLookFailure(): void {
  if (!lookFailureCode) return;
  clearFirstRunOpenCode(lookFailureCode);
  lookFailureCode = null;
}

function dueAt(): number | null {
  try {
    const decision = decide();
    clearLookFailure();
    // Nothing runnable: a stop whose cause ends by itself has its own end time (one timer, no poll); otherwise nothing is due until a signal.
    if (!decision.step) return nextStopLiftAt(decision.account);
    return run!.notBefore;
  } catch (error) {
    console.warn("[first-run] look failed:", error instanceof Error ? error.message : error);
    noteLookFailure(error);
    return null;
  }
}

// --- one pass: one unit of work -------------------------------------------------------------------------------------------------

const stopCodeName = (code: string): string => `first_run:${code}`;
/** A stop is also an open code (the memory screen's status line): the reason shows until the step runs again. */
function stop(account: AccountRun, step: string, code: string, retry?: "later" | "never"): void {
  const before = account.stopped.get(step);
  if (before && before.code !== code) clearFirstRunOpenCode(stopCodeName(before.code));
  account.stopped.set(step, { code, at: now(), ...(retry === "later" ? { retryable: true } : {}) });
  // The two reasons that already have their own notice code (disk_low; engines_not_confirmed with the guidance step 1 gave) are shown by that code, not twice.
  const shownBySurface = code === "remaining/disk_low" || code === "remaining/disk_full" || (code === "remaining/engines_not_confirmed" && account.copiesCode !== null);
  if (!shownBySurface) noteFirstRunOpenCode(stopCodeName(code));
  // D3: a stop the engine said asking again cannot change is final at once; one it said can change is final when this run's bounded asking (three waits) is used up. Other stops are not judged here.
  if (retry === "never" || (retry === "later" && (account.retries.get(step) ?? 0) >= IDLE_JOB_FAILURE_WAITS_MS.length)) markFirstRunFinalCode(stopCodeName(code));
}
function releaseStop(account: AccountRun, step: string): void {
  const info = account.stopped.get(step);
  if (!info) return;
  account.stopped.delete(step);
  clearFirstRunOpenCode(stopCodeName(info.code));
}
function surface(code: NoticeCode, account: AccountRun): void {
  const current = run!;
  noteFirstRunOpenCode(`first_run:${code}`);
  if (current.notified.has(code)) return;
  current.notified.add(code);
  (hooks.notify ?? defaultNotify)({ code, accountKey: account.key });
}
function toCount(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }

function applyDisposition(account: AccountRun, step: string, disposition: Disposition): void {
  const current = run!;
  if (disposition.kind !== "wait") account.busyInARow = 0;
  if (disposition.kind === "done") { account.done.add(step); account.retries.delete(step); releaseStop(account, step); current.notBefore = 0; return; }
  if (disposition.kind === "again") { current.notBefore = now() + disposition.afterMs; return; }
  if (disposition.kind === "wait") {
    account.busyInARow += 1;
    if (account.busyInARow > MAX_BUSY_IN_A_ROW) { stop(account, step, disposition.code); account.busyInARow = 0; return; }
    current.notBefore = now() + disposition.afterMs;
    return;
  }
  stop(account, step, disposition.code, disposition.retry);
  current.notBefore = 0;
}

async function engineCall(step: EngineStep, args: string[], timeoutMs: number, input?: string): Promise<ReturnType<typeof judgeSteps>> {
  const current = run!;
  current.calls += 1;
  let reply;
  try { reply = await runner()({ kind: "steps", args, timeoutMs, ...(input !== undefined ? { input } : {}) }, current.signal); }
  catch { reply = { stdout: "", stderr: "", timedOut: true, cancelled: false }; }
  return judgeSteps(step, reply);
}

/** One engine command of step 5 (`reclassify`, `label_candidates`, `apply_labels`): the same launcher, owner binding and last-JSON-line judgment as `steps`. */
async function classifyEngine(args: string[], timeoutMs: number, input?: string): Promise<import("./first-run-engine").EngineReply> {
  const current = run!;
  current.calls += 1;
  try { return await runner()({ kind: "classify", args, timeoutMs, ...(input !== undefined ? { input } : {}) }, current.signal); }
  catch { return { stdout: "", stderr: "", timedOut: true, cancelled: false }; }
}

async function runOneImportStep(account: AccountRun): Promise<void> {
  const outcome = hooks.oneImport ? await hooks.oneImport() : await (async () => {
    const mod = await import("../memory/one-import");
    const result = await mod.runOneImportInBackground({});
    return { reason: result.reason, retryable: mod.oneImportHasRetryableFailures(result) };
  })();
  // Nothing to import here, so it is retired at once (section 11.5): One is off, the drawer belongs to the device's own store and this store is an
  // account's or a signed-out one (`legacy_owner_unbound`), or there is no drawer file (`soul_missing`). A stop (the app is closing) or an error is not.
  if (outcome.reason === "one_off" || outcome.reason === "legacy_owner_unbound" || outcome.reason === "soul_missing" || (!outcome.reason && !outcome.retryable)) writeRootMeta(ONE_IMPORT_RETIRED_KEY, new Date(now()).toISOString());
  else stop(account, "one-import", outcome.reason ? `one_import/${outcome.reason}` : "one_import/retryable_failures");
}

async function runCopiesStep(account: AccountRun): Promise<ReturnType<typeof judgeSteps>> {
  account.copiesRan = true;
  const judged = await engineCall("engine_copies", ["steps", "--only", "engine_copies"], COPIES_TIMEOUT_MS);
  if (judged.state === "done") { account.copiesDone = true; if (account.copiesNote) { clearFirstRunOpenCode(account.copiesNote); account.copiesNote = null; } }
  // Audit 62 (first run D7): why step 1 did not finish (offline, the updater failed, it will try at the next start) was nowhere; it shows as its own code until step 1 is done. It never holds a step back.
  else if (judged.reason && judged.reason !== "host_plugin_restart" && judged.reason !== "host_plugin_manual") {
    const note = `first_run:copies/${judged.state}/${judged.reason}`.slice(0, 80);
    if (account.copiesNote && account.copiesNote !== note) clearFirstRunOpenCode(account.copiesNote);
    account.copiesNote = note; noteFirstRunOpenCode(note);
  }
  // Step 1 never holds the steps after it back: the engine reads the copies itself when step 6 starts and waits there.
  if (judged.state === "remaining" && (judged.reason === "host_plugin_restart" || judged.reason === "host_plugin_manual")) { account.copiesCode = judged.reason; surface(judged.reason, account); }
  const updater = judged.step?.updater as { status?: unknown } | undefined;
  if (updater && typeof updater.status === "string" && updater.status !== "not_needed" && updater.status !== "not_run") {
    // The installed engine may have changed on disk: look at the root again (its own signal is ignored for this one call).
    const engine = await import("../hephaestus/engine");
    run!.selfReset = true;
    try { engine.resetHephaestusCache(); } finally { run!.selfReset = false; }
  }
  return judged;
}

async function runEmptyStep(account: AccountRun): Promise<void> {
  const judged = await engineCall("empty_turns", ["steps", "--only", "empty_turns", "--no-updater", "--budget-seconds", String(BUDGET_SECONDS)], CALL_TIMEOUT_MS);
  const deleted = judged.step?.deleted as Record<string, unknown> | undefined;
  const tickets = toCount(deleted?.tickets);
  if (tickets > 0 || Object.values(deleted ?? {}).some((value) => toCount(value) > 0)) account.wrote = true;
  account.counts.turns += tickets;
  applyDisposition(account, "empty", judged.disposition);
  if (judged.disposition.kind === "done") account.done.add("empty");
}

/**
 * Step 4b: the engine's `tidy` (first_run_tidy.py). The desktop adds the one thing only it knows: which agents were removed. The ids come from `removedAgentIds`; the engine checks each again
 * (an agent that still has a folder on this computer is skipped) and `forget_agent`s the rest. `tidy` before the move and `tidy2` after it are the same call (the units are idempotent; the second sees the sub-stores).
 */
async function runTidyStep(account: AccountRun, id: "tidy" | "tidy2"): Promise<void> {
  let removed: string[] = [];
  // Only the run's second look (after the move, so the home move of step 2 has rewritten the registry) may name anybody.
  let plan: RemovedAgentsPlan = { ids: [], hold: id === "tidy2" ? null : "homes_not_done" };
  if (id === "tidy2") { try { plan = (hooks.removedAgents ?? removedAgentPlan)(); } catch { plan = { ids: [], hold: "registry_unreadable" }; } }
  removed = plan.ids;
  for (const word of ["registry_empty", "registry_unreadable", "removed_over_half", "agent_root_unseen", "root_move_open", "homes_not_done"]) clearFirstRunOpenCode(REMOVED_AGENTS_CODE_PREFIX + word);
  if (plan.hold && id === "tidy2") noteFirstRunOpenCode(REMOVED_AGENTS_CODE_PREFIX + plan.hold);
  const args = ["steps", "--only", "tidy", "--no-updater", "--budget-seconds", String(BUDGET_SECONDS), ...(removed.length ? ["--removed-agents-stdin"] : [])];
  const judged = await engineCall("tidy", args, CALL_TIMEOUT_MS, removed.length ? JSON.stringify({ agents: removed }) : undefined);
  const units = Array.isArray(judged.step?.units) ? judged.step!.units as Array<Record<string, unknown>> : [];
  for (const unit of units) {
    const gone = toCount(unit.removed) + toCount(unit.rewritten) + toCount(unit.filled) + toCount(unit.rows) + toCount(unit.drawers) + toCount(unit.agents);
    if (gone > 0) account.wrote = true;
    if (unit.unit === "hub_drawers") account.counts.removed += toCount(unit.rows) + toCount(unit.drawers);
    if (unit.unit === "removed_agents") account.counts.removed += toCount(unit.agents);
  }
  applyDisposition(account, id, judged.disposition);
  if (judged.disposition.kind === "stop" && (judged.reason === "disk_low")) surface("disk_low", account);
  if (judged.disposition.kind === "done") account.done.add(id);
}

/** Why the removed-agents unit was not asked this time (closed words; the open code `first_run:removed_agents/<word>` shows while it holds, and the next run looks again). */
export type RemovedAgentsHold = "registry_empty" | "registry_unreadable" | "removed_over_half" | "agent_root_unseen" | "root_move_open" | "homes_not_done";
export interface RemovedAgentsPlan { ids: string[]; hold: RemovedAgentsHold | null }
export const REMOVED_AGENTS_CODE_PREFIX = "first_run:removed_agents/";
/** More than this share of the agents that have memory looking "removed" is not a removal, it is a registry that is wrong (a restored database, an account switch, a broken table, a move in the middle): nothing is deleted. */
export const REMOVED_AGENTS_MAX_SHARE = 0.5;

/**
 * The agents this app says are removed, as far as it can SAY so: an agent id that still has memory lines in the root, is not in the app's agent list (installed agents, identity map), and that the app has seen
 * before (a use record or a task participant). An id with no trace in the app is not named: whose it is cannot be told, and "a line nobody can tell the owner of is kept" (SCOPE C7). At most 500.
 * A deletion cannot be undone, so the registry is distrusted first (coordinator ruling after K5'): an empty or unreadable `installed_agents` names nobody; more than half of the agents that have memory named
 * as removed names nobody (`removed_over_half`); an agent root that cannot be seen (not mounted, settings invalid) or a root move still open names nobody; and nobody is named before this run's home move (step 2)
 * has rewritten the registry. Whatever holds is returned as a closed word and the unit is not asked.
 */
export function removedAgentPlan(): RemovedAgentsPlan {
  const none = (hold: RemovedAgentsHold): RemovedAgentsPlan => ({ ids: [], hold });
  const app = appDb(), root = rootDb();
  if (!homesRan()) return none("homes_not_done");
  if (rootMoveOpen()) return none("root_move_open");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const status = (require("../agents/home") as typeof import("../agents/home")).agentHomeRootStatus();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    if (!status.available || !status.path || !fs.statSync(status.path).isDirectory()) return none("agent_root_unseen");
  } catch { return none("agent_root_unseen"); }
  const live = new Set<string>(), liveIds = new Set<string>();
  try {
    const installed = app.prepare("SELECT id, slug FROM installed_agents").all() as Array<{ id: string; slug: string }>;
    if (installed.length === 0) return none("registry_empty");
    for (const row of installed) { live.add(row.id); live.add(row.slug); liveIds.add(row.id); }
  } catch { return none("registry_unreadable"); }
  const ids = (root.prepare("SELECT DISTINCT agent_id FROM memory_entries WHERE scope='agent_repo' AND agent_id IS NOT NULL LIMIT 5000").all() as Array<{ agent_id: string }>).map((row) => row.agent_id)
    .filter((id) => !/^(host:|hub:|builtin-agentlas-)/.test(id) && id !== "agentlas-one");
  if (!ids.length) return { ids: [], hold: null };
  try { for (const row of app.prepare("SELECT immutable_agent_id AS id FROM agent_identity_map").all() as Array<{ id: string }>) live.add(row.id); } catch { /* an older database has no map */ }
  const seen = new Set<string>();
  try { for (const row of app.prepare("SELECT agent_key AS id FROM agent_usage").all() as Array<{ id: string }>) seen.add(row.id); } catch { /* none */ }
  try { for (const row of app.prepare("SELECT agent_id AS id, agent_slug AS slug FROM task_agent_participants").all() as Array<{ id: string | null; slug: string }>) { if (row.id) seen.add(row.id); seen.add(row.slug); } } catch { /* none */ }
  const named = ids.filter((id) => !live.has(id) && seen.has(id));
  // "the agents that have memory" = those with lines in the root and those the registry lists (their lines are in their own stores once moved)
  const everyone = new Set<string>([...ids, ...liveIds]);
  if (named.length > everyone.size * REMOVED_AGENTS_MAX_SHARE) return none("removed_over_half");
  return { ids: named.slice(0, 500), hold: null };
}
/** Kept under its old name for callers that only want the ids. */
export function removedAgentIds(): string[] { return removedAgentPlan().ids; }

/** Step 6c (K5'): arm the one long first gathering. One app meta row (the gathering's own `memory_gather_since`), nothing else; no model is called here (the resting-time gathering calls it, or waits until one is connected). */
function runGatherStep(account: AccountRun): void {
  writeAppMeta(GATHER_SINCE_KEY, gatherSinceValue(now()));
  account.gatherArmed = true;
}

/** The engine's reasons (`notDeclared[].reason`) that mean "the install record is out of date", not "the program is still open". */
const STALE_RECORD_REASONS: ReadonlySet<string> = new Set(["copy_not_found", "activation_unreadable", "active_version_not_found", "installed_plugins_unreadable"]);
function staleInstallRecord(step: Record<string, unknown> | null): boolean {
  const list = step?.notDeclared;
  return Array.isArray(list) && list.some((item) => !!item && typeof item === "object" && STALE_RECORD_REASONS.has(String((item as { reason?: unknown }).reason)));
}

async function runMoveStep(account: AccountRun): Promise<void> {
  account.lateChecked = true;
  const args = ["steps", "--only", "memory_move", "--no-updater", "--budget-seconds", String(BUDGET_SECONDS)];
  if (homesRan()) args.push("--homes-ready");
  const judged = await engineCall("memory_move", args, CALL_TIMEOUT_MS);
  const moved = toCount(judged.step?.moved);
  if (moved > 0) {
    account.wrote = true;
    account.counts.rows += moved;
    // A move lowers the forget numbers of the stores it fills: the start-up catch-up must compare them all once more.
    try { (await import("../memory/forget-stores")).invalidateCatchUpMarker(); } catch { /* the next start compares anyway */ }
  }
  applyDisposition(account, "move", judged.disposition);
  // Audit 62 (first run B4): the engine says empty turn records are there again (a turn's work lines passed their 24 hours while step 6 waited): step 4 is not done after all. Sent back at most three times
  // in a run; past that the move stops with its own code instead of calling the engine without end.
  if (judged.reason === "empty_turns_pending" && judged.disposition.kind === "again") {
    if (account.emptyRedo < 3) { account.emptyRedo += 1; account.done.delete("empty"); } else stop(account, "move", "remaining/empty_turns_pending");
  }
  if (judged.disposition.kind === "stop") {
    const reason = judged.reason;
    // Audit 62 (first run D1): `disk_full` shows like `disk_low` (it had no code and no notice).
    if (reason === "disk_low" || reason === "disk_full") surface("disk_low", account);
    // Audit 62 (first run B12): an engine copy that is "not confirmed" because its install record is stale (the file it names is gone, the activation mark is missing or unreadable) is not
    // fixed by closing Claude Code: the guidance is the manual update, not "close".
    else if (reason === "engines_not_confirmed" && staleInstallRecord(judged.step)) { account.copiesCode = "host_plugin_manual"; surface("host_plugin_manual", account); }
    // Only the guidance step 1 itself gave: a timed-out or offline updater (`failed/updater_timeout`, `engine_offline`) must not tell the person to close Claude Code.
    else if (reason === "engines_not_confirmed" && account.copiesCode) surface(account.copiesCode, account);
  } else if (judged.disposition.kind === "done") clearFirstRunOpenCode("first_run:host_plugin_restart");
}

/**
 * Step 6b: the workspace-rules switch (first-run-rules.ts). One unit, in this order, each refusal a machine code (`first_run:rules/<code>`) and never a silent stop or a "done":
 *  1. `rules/ruleset_unusable`     this build's ruleset copy cannot be read or lacks the switch's keys: the desktop would read the switch as off, so the row is not written (P3a finding).
 *  2. `rules/engine_not_capable`   no engine on this computer can be asked about its copies: nothing is confirmed, nothing is flipped.
 *  3. `rules/engines_not_confirmed` / `rules/engine_no_answer`   an engine copy (an open Claude Code or Codex window) does not declare the layout yet, or the engine gave no answer: the switch waits for the same
 *     confirmation as step 6, the guidance of step 1 shows, and a signal asks again; the end notice does not say "finished" meanwhile. An engine copy that declares the layout carries the switch too (both shipped in one
 *     release; the capability number did not move for the switch), so the one check is enough.
 *  4. the account is the one the step was picked for (an account switch during the engine call writes nothing; the next look decides again), then the flip (one statement, first-run-rules.ts), re-read after it.
 * A busy store waits and asks again (the shared `busyInARow`, as every other step); anything else the write throws is `failed/exception`. Nothing is written but the one row.
 */
async function runRulesStep(account: AccountRun): Promise<void> {
  const current = run!;
  if (!rulesetCarriesSwitch()) { stop(account, "rules", "rules/ruleset_unusable"); return; }
  if (!account.copiesDone) {
    if (!probe().capable) { stop(account, "rules", "rules/engine_not_capable"); return; }
    const judged = await runCopiesStep(account);
    if (!account.copiesDone) { stop(account, "rules", judged.state === "remaining" ? "rules/engines_not_confirmed" : "rules/engine_no_answer"); return; }
    clearFirstRunOpenCode("first_run:host_plugin_restart"); clearFirstRunOpenCode("first_run:host_plugin_manual");
  }
  if (accountIdentity()?.key !== account.key) { current.notBefore = 0; return; }   // another account became current while the engine was asked: nothing is written, the next look decides again
  let result;
  try { result = flipWorkspaceRules(rootDb()); }
  catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)/.test(code)) { applyDisposition(account, "rules", { kind: "wait", code: "busy", afterMs: WAIT_PAUSE_MS }); return; }
    throw error;
  }
  if (result === "layout_not_split") { current.notBefore = now() + WAIT_PAUSE_MS; return; }   // the engine took the layout back between the look and the write: not flipped, looked at again
  if (ensureOutsideMarker() === "failed") { current.notBefore = now() + WAIT_PAUSE_MS; return; }   // the machine word for windows opened outside the app is part of the step: not done until it is written; the row is on, so the next look only retries the file
  account.busyInARow = 0;
  account.done.add("rules"); account.rulesOn = true; releaseStop(account, "rules");
  if (result === "on") account.rulesPick = pickListHasCandidates();
  current.notBefore = 0;
  syncOpenWork();
}

/** The registered projects that have a folder on this computer, as `ID=FOLDER` / `ID=NAME` entries (a project without a folder is not handed over). */
function projectLists(): { projects: string[]; names: string[] } {
  let projects: ReadonlyArray<{ id: string; name: string; folderPath: string | null }>;
  if (hooks.projects) projects = hooks.projects();
  else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    projects = (require("../store/projects") as typeof import("../store/projects")).listProjects();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const folders: string[] = [], names: string[] = [];
  for (const project of projects) {
    const folder = project.folderPath;
    if (!project.id || !folder || /[\r\n\0]/.test(folder)) continue;
    let isDirectory = false;
    try { isDirectory = fs.statSync(folder).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) continue;
    folders.push(`${project.id}=${folder}`);
    if (project.name?.trim() && !/[\r\n\0]/.test(project.name)) names.push(`${project.id}=${project.name.trim()}`);
  }
  return { projects: folders, names };
}

/** The same lists as the `--project` / `--project-name` arguments of `reclassify`: only for an engine that does not read the list from standard input (defect 7). */
function projectArguments(lists: { projects: string[]; names: string[] }): { args: string[]; tooLong: boolean } {
  const folders = lists.projects.flatMap((entry) => ["--project", entry]);
  const names = lists.names.flatMap((entry) => ["--project-name", entry]);
  const size = (list: string[]): number => list.reduce((sum, item) => sum + item.length + 1, 0);
  // Over the length one command line may have: the names go first (they only help the second tie-break); a still longer list is not handed over at all (never a partial list: 5a ends once).
  if (size(folders) + size(names) <= MAX_PROJECT_ARGS_CHARS) return { args: [...folders, ...names], tooLong: false };
  if (size(folders) <= MAX_PROJECT_ARGS_CHARS) return { args: folders, tooLong: false };
  return { args: [], tooLong: true };
}

async function runClassifyStep(account: AccountRun): Promise<void> {
  const lists = projectLists();
  // The list goes on standard input: a command line cannot carry a long one (defect 7; 97 to 223 projects were past the limit). An engine that does not know the flag answers
  // `bad_arguments` (it fails the parse before it reads anything), and only then are the arguments used, as before, when they fit.
  let judged = lists.projects.length
    ? judgeClassify(await classifyEngine(["reclassify", "--projects-stdin", "--budget-seconds", String(BUDGET_SECONDS)], CALL_TIMEOUT_MS, JSON.stringify({ projects: lists.projects, names: lists.names })))
    : null;
  if (!judged || judged.json?.reason === "bad_arguments") {
    const projects = projectArguments(lists);
    if (projects.tooLong) { stop(account, "classify", "classify/projects_args_too_long"); return; }
    judged = judgeClassify(await classifyEngine(["reclassify", ...projects.args, "--budget-seconds", String(BUDGET_SECONDS)], CALL_TIMEOUT_MS));
  }
  const moved = toCount(judged.json?.moved);
  if (moved > 0) {
    account.wrote = true;
    // D4: a line that only changed its kind or scope where it sits (`inPlace`) is carried to its store by step 6 and counted there: counted here too it would be counted twice
    // (1,831 shown for 1,405 moved on the owner's copy). An engine without the field counts as before.
    account.counts.rows += Math.max(0, moved - Math.min(moved, toCount(judged.json?.inPlace)));
    // A move lowers the forget numbers of the stores it fills: the start-up catch-up must compare them all once more.
    try { (await import("../memory/forget-stores")).invalidateCatchUpMarker(); } catch { /* the next start compares anyway */ }
  }
  applyDisposition(account, "classify", judged.disposition);
  if (judged.disposition.kind === "stop" && judged.reason === "disk_full") surface("disk_low", account);
}

/** Step 5b: one batch per pass (a model call, one engine apply). The loop is the idle job's: `pass` returns true and the next look comes at once. */
async function runLabelsStep(account: AccountRun): Promise<void> {
  const current = run!;
  const deps: LabelDeps = {
    route: hooks.labels?.route ?? defaultLabelRoute,
    model: hooks.labels?.model ?? ((request, route) => defaultLabelModel(request, route, current.signal)),
    engine: (args, input) => classifyEngine(args, CALL_TIMEOUT_MS, input),
  };
  const outcome: LabelOutcome = await runLabelBatch(deps);
  if (outcome.kind === "again") {
    account.busyInARow = 0;
    account.labels.batches += 1; account.labels.applied += outcome.applied; account.labels.kept += outcome.kept; account.labels.modelCalls += outcome.modelCalls;
    if (outcome.applied > 0) account.wrote = true;
    releaseStop(account, "labels");
    current.notBefore = now() + AGAIN_PAUSE_MS;
    return;
  }
  if (outcome.kind === "done") {
    // The last batch may have applied lines (apply_labels answers `done` when nothing is left after it).
    if (outcome.modelCalls > 0) account.labels.batches += 1;
    account.labels.applied += outcome.applied; account.labels.kept += outcome.kept; account.labels.modelCalls += outcome.modelCalls;
    if (outcome.applied > 0) account.wrote = true;
    account.done.add("labels"); releaseStop(account, "labels"); clearFirstRunOpenCode(LABELS_PENDING_CODE); current.notBefore = 0; return;
  }
  if (outcome.kind === "pending_reclassify") { stop(account, "labels", "labels/reclassify_pending"); return; }
  if (outcome.kind === "wait") {
    // A store another process holds, or a forget by another process during the call: stand aside, then ask again (a bounded number of times in a row).
    account.labels.modelCalls += outcome.modelCalls;
    account.busyInARow += 1;
    if (account.busyInARow > MAX_BUSY_IN_A_ROW) { stop(account, "labels", outcome.code); account.busyInARow = 0; return; }
    current.notBefore = now() + WAIT_PAUSE_MS;
    return;
  }
  if (outcome.kind === "waiting_model") {
    // No model is connected (or none could be reached): the engine is told once (`waiting_model`); a home that already says so costs no process at start. The next runtime change looks again.
    if (readClassifyMarks().llmState !== "waiting_model") await markWaitingModel((args, input) => classifyEngine(args, CALL_TIMEOUT_MS, input));
    stop(account, "labels", "labels/waiting_model");
    setOpenWork(rulesStillOwed());
    return;
  }
  account.labels.modelCalls += outcome.modelCalls;
  stop(account, "labels", outcome.code);
}

/** A stop of step 7 is the app run's (not an account's) and is shown as a code like every other stop. */
function stopIndex(code: string): void {
  const current = run!;
  if (current.index.stop) clearFirstRunOpenCode(stopCodeName(current.index.stop));
  current.index.stop = code;
  current.index.stopAt = now();
  noteFirstRunOpenCode(stopCodeName(code));
  current.notBefore = 0;
}

/** Step 7: the old code-map folders move to the new place. `done` = every candidate was looked at (a failed project is tried again at the next start); `busy` waits; the rest stops for this run. */
async function runIndexStep(account: AccountRun): Promise<void> {
  const current = run!;
  const report = hooks.relocate ? await hooks.relocate({ signal: current.signal, limit: 8 })
    : await (await import("../memory/project-index-relocate")).relocateProjectIndexesOnce({ signal: current.signal, limit: 8 });
  if (report.state === "busy") { account.busyInARow += 1; if (account.busyInARow > MAX_BUSY_IN_A_ROW) { account.busyInARow = 0; stopIndex("index/busy"); } else current.notBefore = now() + WAIT_PAUSE_MS; return; }
  account.busyInARow = 0;
  if (report.state === "switch_off" || report.state === "aborted") { stopIndex(`index/${report.state}`); return; }
  if (report.done) { current.index.done = true; clearFirstRunOpenCode(stopCodeName(current.index.stop ?? "")); current.index.stop = null; current.notBefore = 0; }
  else {
    // Audit 62 (first run B5): a pass that leaves the same number of folders waiting and failing as the one before it made no progress (the same few folders fail every time and sit in front of the rest): after three
    // such passes the step stops with its own code instead of refreshing eight code maps a second for ever.
    const signature = `${report.remaining}/${report.failed}`;
    current.index.same = signature === current.index.last ? (current.index.same ?? 0) + 1 : 0;
    current.index.last = signature;
    if (current.index.same >= 2) { stopIndex("index/no_progress"); return; }
    current.notBefore = now() + AGAIN_PAUSE_MS;
  }
}

async function runHomesStep(account: AccountRun): Promise<void> {
  const current = run!;
  current.homesStale = false;
  const report = hooks.rerunHomeMove ? await hooks.rerunHomeMove(current.signal)
    : await (await import("../agents/home-move")).runAgentHomeMovePass({ signal: current.signal });
  if (current.legacy) current.legacy.homeMove = report;
  if (!report || report.skipped) stop(account, "homes", report?.skipped ?? "failed");
  else account.counts.folders += report.moved;
}

/** The longest one pass held Main in this run (milliseconds; tests and the quit log read it). */
let harnessLongestUnitMs = 0;
function runHarnessStep(account: AccountRun): void {
  // One table per pass (a drop of the biggest one is a single write; all eleven in one transaction held Main for 0.8 s on a 77 MB store); the idle job comes back at once.
  const result = runHarnessCleanup(appDb(), { limit: 1 });
  if (result.error) { stop(account, "harness", `harness/${result.error}`); return; }
  if (result.dropped.length) { if (run) run.notBefore = now() + HARNESS_PAUSE_MS; return; }
  // The AGI tables are gone (or one is referenced and stays): the Alive tables of the deleted One / Work lives, one bounded unit per pass.
  const unit: AliveUnitResult = runAliveCleanupUnit(appDb());
  harnessLongestUnitMs = Math.max(harnessLongestUnitMs, unit.ms);
  if (unit.error) { stop(account, "harness", `harness/${unit.error}`); return; }
  // (`wrote` stays as it is: the Alive rows live in the app store, and the quit-time VACUUM is the engine's, of the memory root.)
  if (!unit.done) { if (run) run.notBefore = now() + HARNESS_PAUSE_MS; return; }
  if (result.blocked.length) stop(account, "harness", "harness/referenced");
}

function runNoticeStep(account: AccountRun): void {
  const counts = account.counts;
  // Audit 62 (first run B11): "finished" is not said over a move that left lines behind (`partial`); the marker is still written so the end is not held back.
  const something = (counts.folders + counts.rows + counts.turns + counts.removed > 0 || account.rulesPick) && !movePartialSettled(account);
  // The marker first: a notice shown and then a crash must not show again, and a crash before the marker shows it at the next start.
  persistCounts(account, true);   // before the marker: a screen that sees "finished" finds the totals
  writeAppMeta(NOTICE_KEY_PREFIX + account.key, new Date(now()).toISOString());
  setFirstRunStep(null);
  emitFirstRunStateChange();
  syncOpenWork();
  if (something || counts.removed > 0) (hooks.notify ?? defaultNotify)({ code: "done", accountKey: account.key, ...(account.rulesPick ? { rulesPick: true as const } : {}), ...(counts.removed > 0 ? { removed: counts.removed } : {}) });
  clearFirstRunOpenCode("first_run:host_plugin_restart");
  clearFirstRunOpenCode("first_run:host_plugin_manual");
  clearFirstRunOpenCode("first_run:disk_low");
}

async function dreamingPassInFlight(): Promise<boolean> {
  try { return (await import("../memory/dreaming")).getDreamingStatus().running; } catch { return false; }
}

const ENGINE_STEPS: ReadonlySet<StepId> = new Set(["copies", "empty", "tidy", "tidy2", "move", "homes", "classify"]);

/** BB-1a: the step this pass starts, for the line's "n/total" (only the steps of PROGRESS_STEPS, and only for an account whose end notice is not written yet). One single-row read. */
function noteProgress(account: AccountRun, step: StepId): void {
  const at = PROGRESS_STEPS.indexOf(step);
  if (at < 0) return;
  try { if (readAppMeta(NOTICE_KEY_PREFIX + account.key) !== null) return; } catch { return; }
  setFirstRunStep({ n: at + 1, total: PROGRESS_STEPS.length });
}

/** One pass at a time: a second caller (a signal landing while a pass runs) gets that pass's result instead of starting an engine call of its own. */
let passInFlight: Promise<boolean> | null = null;
function pass(): Promise<boolean> {
  if (passInFlight) return passInFlight;
  const current: Promise<boolean> = passOnce().finally(() => { if (passInFlight === current) passInFlight = null; });
  passInFlight = current;
  return current;
}

async function passOnce(): Promise<boolean> {
  if (!run || run.signal?.aborted) return false;
  let decision = decide();
  const account = decision.account;
  if (!decision.step || !account) return false;
  const step = decision.step;
  noteProgress(account, step);
  try {
    // From the first call that deletes or moves rows until no engine step is left, the row-rewriting background jobs stand aside.
    if ((step === "empty" || step === "tidy" || step === "tidy2" || step === "move" || step === "classify") && !run.releaseMove) {
      run.releaseMove = beginMemoryMove();
      // A dreaming pass that began before the gate closed finishes first; the call is aimed a few seconds later (the gate stays closed meanwhile).
      if (await dreamingPassInFlight()) { run.notBefore = now() + WAIT_PAUSE_MS; return true; }
    }
    if (step === "one-import") await runOneImportStep(account);
    else if (step === "copies") await runCopiesStep(account);
    else if (step === "empty") await runEmptyStep(account);
    else if (step === "tidy" || step === "tidy2") await runTidyStep(account, step);
    else if (step === "gather") runGatherStep(account);
    else if (step === "move") await runMoveStep(account);
    else if (step === "rules") await runRulesStep(account);
    else if (step === "classify") await runClassifyStep(account);
    else if (step === "labels") await runLabelsStep(account);
    else if (step === "index") await runIndexStep(account);
    else if (step === "homes") await runHomesStep(account);
    else if (step === "harness") runHarnessStep(account);
    else if (step === "notice") runNoticeStep(account);
    return true;
  } catch (error) {
    console.warn(`[first-run] step ${step} failed:`, error instanceof Error ? error.message : error);
    // Step 7's stop is the run's, not the account's (first run B3: the look read `index.stop` and never saw this one, so the step was picked again at once for ever).
    if (step === "index") stopIndex("index/exception"); else stop(account, step, "failed/exception");
    return true;
  } finally {
    persistCounts(account);   // BB-1a: whatever this pass counted survives a crash after it (written only when the totals changed)
    // Release the gate unless the next unit is an engine step that writes.
    try { decision = decide(); } catch { decision = { step: null, account }; }
    // Audit 62 (first run B13): the door also opens while the next unit WAITS for a long time (the person is at the machine, or the wait is longer than a busy pause): dreaming, the English migration and a root move
    // used to be held out for as long as the person was busy, up to an hour. The next unit takes the door again when it starts (the dreaming-in-flight check there covers a pass that began in between).
    let longWait = false;
    try { longWait = !!run && (run.notBefore - now() > WAIT_PAUSE_MS || userIdleWaitMs() > 0); } catch { longWait = false; }
    if (!(decision.step && ENGINE_STEPS.has(decision.step) && !longWait) && run?.releaseMove) { run.releaseMove(); run.releaseMove = null; }
  }
}

// --- start / stop --------------------------------------------------------------------------------------------------------------

/** Called by the start chain once its agent-folder and experience-chip steps have run (their reports may be null when a step threw). */
export function noteLegacySteps(input: { homeMove: HomeMoveReport | null; chips: ChipAbsorbResult | null }): void {
  if (!run) return;
  run.legacy = input;
  const account = (() => { const identity = accountIdentity(); return identity ? accountRun(identity) : null; })();
  if (account && input.homeMove && !input.homeMove.skipped) { account.counts.folders += input.homeMove.moved; persistCounts(account); }
  // Audit 62 (first run B16): the start chain's folder pass skipped or threw: step 6 waited for an "agent changed" signal with no code at all. It is a stop of the folder step now, with its code showing: the agent-changed signal lifts it
  // (as before), and a cause that ends by itself (the drive is back, the root move is over) is asked again after the idle job's own waits (`liftTimedStops`).
  if (account && (!input.homeMove || input.homeMove.skipped)) stop(account, "homes", input.homeMove?.skipped ?? "failed");
  run.job?.wake();
}

/**
 * Starts the conductor (Main, after the window is up). Does nothing when the switch is off or the store is not this process's to migrate.
 * `signal` ends it: the idle job stops and an engine call in flight is killed (the engine is safe to kill: a batch is whole or absent).
 */
export async function startFirstRunMigration(options: { signal?: AbortSignal; firstLookMs?: number } = {}): Promise<boolean> {
  if (run) return false;
  const refusal = firstRunStartRefusal();
  if (refusal) {
    if (refusal !== "disabled") {
      noteFirstRunOpenCode(`first_run:${refusal}`);
      console.info(`[first-run] not started: ${refusal}`);
    }
    if (refusal === "store_follower" && !followerRuntimeWatch) {
      try { followerRuntimeWatch = (await import("../store/change-bus")).onDesktopStoreChange((change) => { if (change.entity === "runtime") reopenWorkAfterRuntimeChange(); }); } catch { /* no bus here: the next owner start looks */ }
    }
    return false;
  }
  const [{ createIdleJob }, { onDesktopStoreChange }] = await Promise.all([import("../memory/idle-job"), import("../store/change-bus")]);
  run = { signal: options.signal, job: null, offs: [], legacy: null, account: null, notBefore: 0, homesStale: false, calls: 0, releaseMove: null, notified: new Set(), selfReset: false, index: { done: false, stop: null }, openWorkSynced: false, look: null };
  const current = run;
  const signals: Array<(wake: () => void) => () => void> = [
    // An agent folder moved (or an agent that was running finished and its folder moved): the folder step may now be ready.
    (wake) => onDesktopStoreChange((change) => {
      if (change.entity !== "agent") return;
      current.homesStale = true;
      // Audit 62 (first run B16): a stop of the folder step is lifted by the very signal it waits for (it was only marked stale and stayed stopped).
      if (current.account) releaseStop(current.account, "homes");
      // A finished account sweeps the root again after a folder moved (rows of that agent may have waited there); the revision check keeps it cheap.
      if (current.account) { current.account.done.delete("move"); current.account.lateChecked = false; }
      wake();
    }),
    // A runtime was connected, signed in or changed: step 5b waits for exactly this (no model = `waiting_model`, and a model that gave no usable answer is asked again by the next one).
    (wake) => onDesktopStoreChange((change) => {
      if (change.entity !== "runtime") return;
      const account = current.account;
      reopenWorkAfterRuntimeChange();
      if (account) { const info = account.stopped.get("labels"); if (info && /^labels\/(?:waiting_model|no_answer|no_usable_answer|external)$/.test(info.code)) releaseStop(account, "labels"); }
      wake();
    }),
  ];
  try {
    const engine = await import("../hephaestus/engine");
    signals.push((wake) => engine.onHephaestusEngineReset(() => {
      if (current.selfReset) return;
      // The engine may be new enough now: a stop that was about the engine on disk (not about the data) is lifted, but not within 30 s of itself.
      const account = current.account;
      if (account) for (const [step, info] of [...account.stopped]) {
        if (/engines_not_confirmed|engine_|capab/.test(info.code) && now() - info.at >= ENGINE_STOP_RELEASE_AFTER_MS) releaseStop(account, step);
        // DR-4b: an engine call that failed to answer a moment before the engine on disk was switched under it is asked again (once per switch signal; a later stop is not lifted by an earlier signal).
        else if (/^failed\/(?:no_answer|[A-Z][A-Za-z0-9]{1,60})$/.test(info.code) && now() - info.at < ENGINE_SWITCH_STOP_WINDOW_MS) releaseStop(account, step);
      }
      wake();
    }));
  } catch { /* no engine module here: the start and account signals remain */ }
  try {
    const auth = await import("../auth");
    signals.push((wake) => auth.onAuthSessionOwnershipChanged(() => wake()));
  } catch { /* an account change is then seen at the next look */ }
  current.job = createIdleJob({ due: dueAt, waitMs: userIdleWaitMs, pass, signals });
  current.job.start(options.firstLookMs ?? 1_000);
  const onAbort = (): void => { void stopFirstRunMigration(); };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  return true;
}

export async function stopFirstRunMigration(): Promise<void> {
  const current = run;
  if (!current) return;
  current.job?.stop();
  for (const off of current.offs) { try { off(); } catch { /* already gone */ } }
  current.releaseMove?.();
  current.releaseMove = null;
  // `run` stays readable for the quit-time VACUUM decision; `resetFirstRunForTests` clears it.
}

/**
 * BB-1a: the line's [Retry] (`firstRun:retry`). "Ask again now" for what is stopped: it lifts every stop of this run (the same `releaseStop` the bounded waits use, so the idle job's own look then picks the
 * step again), gives the bounded waits a fresh count and wakes the job. It starts no step of its own and keeps no new state. Refused with a closed word while a pass is running, when this process is not
 * the one running the cleanup (the background service is, or the switch is off), and when nothing is stopped. Never throws.
 */
export function retryFirstRun(): FirstRunRetryAnswer {
  try {
    const current = run;
    if (!current || !current.job || !firstRunMigrationEnabled() || current.signal?.aborted) return { ok: false, code: "not_running_here" };
    if (passInFlight) return { ok: false, code: "running" };
    const account = current.account;
    const stoppedHere = account ? account.stopped.size : 0;
    if (stoppedHere === 0 && !current.index.stop) return { ok: false, code: "nothing_to_retry" };
    if (account) {
      for (const step of [...account.stopped.keys()]) { if (step === "homes") current.homesStale = true; releaseStop(account, step); }
      account.retries.clear();
      account.busyInARow = 0;
      account.copiesRan = false;
    }
    if (current.index.stop) { clearFirstRunOpenCode(stopCodeName(current.index.stop)); current.index.stop = null; current.index.same = 0; current.index.retries = 0; }
    // What the line says while paused; the next pass that stops again says it again (the owner is told once by the notification, `notified`).
    for (const code of ["first_run:disk_low", "first_run:host_plugin_restart", "first_run:host_plugin_manual"]) clearFirstRunOpenCode(code);
    current.notBefore = 0;
    current.job.wake();
    return { ok: true, asked: "again" };
  } catch { return { ok: false, code: "unavailable" }; }
}

/** Test seam: one pass without the idle job's waiting. */
export const passForTests = (): Promise<boolean> => pass();
/** Test seam: the time the idle job's one timer would be aimed at (`dueAt`). */
export const dueAtForTests = (): number | null => dueAt();

export function resetFirstRunForTests(): void {
  void stopFirstRunMigration();
  run = null;
  hooks = {};
  passInFlight = null;
  try { followerRuntimeWatch?.(); } catch { /* gone */ }
  followerRuntimeWatch = null;
  harnessLongestUnitMs = 0;
  lookFailureCode = null;
  engineWaitSince = 0;
  resetFirstRunOpenCodesForTests();
}

/**
 * At quit, after the stores are closed: one VACUUM of the root through the engine, only when this run deleted or moved rows (a root that did not
 * change has nothing to give back). The store is named with `--owner-store` because the owner binding is gone by then. `skipped` / `busy` /
 * `deferred` answers are not retried: the engine's idle `step` offers the VACUUM again, and the next run that writes asks again. Never throws.
 */
export async function runFirstRunVacuumAtQuit(): Promise<{ state: string; reason?: string } | null> {
  try {
    const account = run?.account;
    if (!firstRunMigrationEnabled() || !account || !account.wrote) return null;
    if (!probe().capable) return null;
    try { (await import("../memory/stores")).closeAllStores(); } catch { /* handles that are already closed */ }
    const reply = await runner()({
      kind: "vacuum", useOwnerBinding: false, timeoutMs: VACUUM_CALL_TIMEOUT_MS,
      args: ["vacuum", "--owner-store", account.store8, "--timeout-seconds", String(VACUUM_ENGINE_TIMEOUT_SECONDS)],
    });
    if (reply.timedOut || reply.cancelled) return { state: "failed", reason: "no_answer" };
    const json = lastJsonLine(reply.stdout);
    if (!json) return { state: "failed", reason: "no_answer" };
    return { state: String(json.state ?? "failed"), ...(typeof json.reason === "string" ? { reason: json.reason } : {}) };
  } catch { return null; }
}

/** Read by tests and the quit log only. */
export function firstRunSnapshot(): { calls: number; stopped: Record<string, string>; done: string[]; counts: { folders: number; rows: number; turns: number }; wrote: boolean;
  labels: { batches: number; applied: number; kept: number; modelCalls: number }; harnessLongestUnitMs: number } | null {
  const account = run?.account;
  if (!run || !account) return null;
  return { calls: run.calls, stopped: { ...Object.fromEntries([...account.stopped].map(([step, info]) => [step, info.code])), ...(run.index.stop ? { index: run.index.stop } : {}) },
    done: [...account.done, ...(run.index.done ? ["index"] : [])], counts: { ...account.counts }, wrote: account.wrote,
    labels: { ...account.labels }, harnessLongestUnitMs };
}

export { AGAIN_PAUSE_MS, WAIT_PAUSE_MS, HARNESS_ORPHAN_TABLES };
