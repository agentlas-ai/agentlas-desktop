// How the 2.0 first-run migration talks to the engine (Agentlas 2.0; the contract is section G, which replaced section G).
//
// The rules this file is the one place for:
//  * always a child process (`python -m agentlas_cloud.first_run steps|vacuum`), never an engine module inside a long-lived process;
//  * the answer is the LAST LINE of standard output, parsed as JSON, and its `state` / `reason` decide. The exit code is never read (a failure
//    is exit 0 too). No JSON (the process was killed, the time limit ran out, a wrong argument) is `failed/no_answer`;
//  * `reason` is a code, never shown as it is, and an unknown code is handled by its `state` alone (here: not looped on);
//  * the standard error is one line at most and goes to the local log only (it can hold a path).
import fs from "node:fs";
import path from "node:path";

export type EngineStep = "engine_copies" | "empty_turns" | "tidy" | "memory_move";

/** Engine step 1 runs the installed engine's updater, which can download a release: it gets its own limit and the process tree is ended after it. */
// Shorter than the engine's own limit for the updater (120 s, `first_run_steps.py`): when the engine's limit came first it ended the updater but not the updater's
// children, which stayed behind with no parent (defect 8). This limit comes first and ends the whole process tree (`runtime/exec.ts`).
export const COPIES_TIMEOUT_MS = 110_000;
/** Time each of the other steps works inside one call (the engine's budget); never 0 or negative: 0 means "no limit" to the engine. */
export const BUDGET_SECONDS = 2;
/** A call may be longer than its budget (lock waits of up to 5 s, the first scan of a big store): the process gets budget + 30 s. */
export const CALL_TIMEOUT_MS = (BUDGET_SECONDS + 30) * 1000;
export const VACUUM_ENGINE_TIMEOUT_SECONDS = 5;
export const VACUUM_CALL_TIMEOUT_MS = 20_000;
/** Between two calls that ask "again" at least this long; after `busy` / `locked` at least the second. */
export const AGAIN_PAUSE_MS = 1_000;
export const WAIT_PAUSE_MS = 5_000;

/** `remaining` reasons that mean "call again at once" (G-11). */
export const AGAIN_REASONS: ReadonlySet<string> = new Set(["budget", "more_to_move", "empty_turns_pending"]);
/** `remaining` reasons of a store another process holds for a moment. */
export const WAIT_REASONS: ReadonlySet<string> = new Set(["busy", "locked"]);
/** `remaining` reasons that end this run's calls (G-12); a `failed` answer and any code not listed here end them too. */
export const STOP_REASONS: ReadonlySet<string> = new Set(["no_progress", "partial", "engines_not_confirmed", "disk_low", "quick_check_failed", "layout_unknown", "homes_not_ready"]);

export interface EngineCall {
  /** `classify` = the commands (`reclassify`, `label_candidates`, `apply_labels`, `llm_state`): the same launcher and owner binding as `steps`. */
  kind: "steps" | "vacuum" | "classify";
  args: string[];
  timeoutMs: number;
  /** Standard input for the one command that reads its answers from it (`apply_labels`): ids, fingerprints and store names, no memory text. */
  input?: string;
  /** false for the call made after the app closed its stores (no live owner binding then; the store is named with --owner-store). */
  useOwnerBinding?: boolean;
}
export interface EngineReply {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** The call could not even be made (no owner binding): a machine code, `stop` for this run. */
  unavailable?: string;
}
export type EngineRunner = (call: EngineCall, signal?: AbortSignal) => Promise<EngineReply>;

export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export type Disposition =
  | { kind: "done"; code: string }
  /** Call again after `afterMs`. */
  | { kind: "again"; code: string; afterMs: number }
  /** Stand aside for `afterMs`, then call again (a bounded number of times). */
  | { kind: "wait"; code: string; afterMs: number }
  /**
   * No more calls to this step in this app run; the next start (or a signal that changes the condition) tries again.
   * `retry` is only set by the step 6 `no_progress` answer when the engine said whether asking again can change anything (D3, trial): "later" = it can
   * (a store another program holds, an unwritable store ...), so the conductor asks again after its own bounded waits; "never" = it cannot (a store that
   * lacks a table, an unknown error), so the stop is final and the screen says so. Absent = the engine gave no answer on it: the stop is what it was.
   */
  | { kind: "stop"; code: string; retry?: "later" | "never" };

export interface Judged {
  disposition: Disposition;
  /** The step's own object from `steps[]` (counts such as `moved`, `deleted`, `updater`), or null when there was none. */
  step: Record<string, unknown> | null;
  state: string;
  reason: string;
}

const NO_ANSWER: Judged = { disposition: { kind: "stop", code: "failed/no_answer" }, step: null, state: "failed", reason: "no_answer" };

export function judgeSteps(name: EngineStep, reply: EngineReply): Judged {
  if (reply.unavailable) return { disposition: { kind: "stop", code: reply.unavailable }, step: null, state: "failed", reason: reply.unavailable };
  if (reply.timedOut || reply.cancelled) return NO_ANSWER;
  const json = lastJsonLine(reply.stdout);
  if (!json) return NO_ANSWER;
  const steps = Array.isArray(json.steps) ? json.steps as unknown[] : null;
  if (!steps) {
    // The whole call was refused: the owner could not be bound (`deferred`) or an argument was wrong (`failed/bad_arguments`).
    const state = typeof json.state === "string" ? json.state : "failed", reason = typeof json.reason === "string" ? json.reason : "no_steps";
    return { disposition: { kind: "stop", code: `${state}/${reason}` }, step: null, state, reason };
  }
  const found = steps.find((item): item is Record<string, unknown> => !!item && typeof item === "object" && (item as { name?: unknown }).name === name);
  if (!found) return { disposition: { kind: "stop", code: "failed/step_missing" }, step: null, state: "failed", reason: "step_missing" };
  const state = typeof found.state === "string" ? found.state : "unknown", reason = typeof found.reason === "string" ? found.reason : "";
  const code = reason ? `${state}/${reason}` : state;
  const judged = (disposition: Disposition): Judged => ({ disposition, step: found, state, reason });
  if (state === "done") return judged({ kind: "done", code });
  if (state === "remaining") {
    if (AGAIN_REASONS.has(reason)) return judged({ kind: "again", code, afterMs: AGAIN_PAUSE_MS });
    if (WAIT_REASONS.has(reason)) return judged({ kind: "wait", code, afterMs: WAIT_PAUSE_MS });
    if (name === "memory_move" && reason === "no_progress") return judged(noProgressStop(found, code));
    return judged({ kind: "stop", code }); // listed or unknown: not looped on
  }
  // D1: `failed/<ExceptionName>` is the engine's step raising something it has no code for (the owner's copy: `failed/ValueError` at the first move, gone at the next start). Every step is safe to
  // call again, so it is asked again on the short wait (the conductor's bounded `wait`, then its timed lifts) instead of standing until the app is restarted.
  if (state === "failed" && ENGINE_EXCEPTION.test(reason)) return judged({ kind: "wait", code, afterMs: WAIT_PAUSE_MS });
  return judged({ kind: "stop", code }); // failed, deferred, or a state this build does not know
}

/** A Python exception class name as the engine reports an unclassified failure (`first_run._code`): capitalised, no underscore. The engine's own codes are lower-case words. */
export const ENGINE_EXCEPTION = /^[A-Z][A-Za-z0-9]{1,60}$/;

/** An engine reason name the code may carry (a machine word, never text): lower-case words and digits with underscores. Anything else is not copied into a code. */
const ENGINE_WHY = /^[a-z][a-z0-9_]{0,39}$/;
/**
 * Step 6 `remaining/no_progress` (D3, trial). An engine that says why (`why`: the skip code that kept the most rows) and whether asking again can change anything
 * (`retryable`) is read: the code becomes `remaining/no_progress/<why>` and `retry` says "later" or "never". An engine without those fields (an older copy) gives the
 * plain stop it always gave. Read defensively: a `retryable` that is not a boolean counts as "not said".
 */
function noProgressStop(step: Record<string, unknown>, code: string): Disposition {
  const why = typeof step.why === "string" && ENGINE_WHY.test(step.why) ? step.why : null;
  const full = why ? `${code}/${why}` : code;
  if (typeof step.retryable !== "boolean") return { kind: "stop", code: full };
  return { kind: "stop", code: full, retry: step.retryable ? "later" : "never" };
}

// --- what the engine on this computer can do ------------------------------------------------------------------------------------

/**
 * The first engine that carries every memory-move repair the desktop's switch conditions need (up to engine a4f5c433: team lines stay in the root,
 * forget-agent knows the absorbed copies, forgets made before the switch keep their scope). The engine says so in `agentlas_cloud/capabilities.json`:
 * `memory_layout` is 1 in every engine since the split exists, including the ones before those repairs, so the engine has to raise it to this
 * number in the commit that carries them. Until it does, no installed engine passes this check and the move never starts (fail closed). A commit hash is never compared.
 */
export const REQUIRED_MEMORY_LAYOUT_CAPABILITY = 2;

export interface EngineProbe {
  /** `first_run_steps.py` is there: the engine knows the steps (an engine without them cannot run even step 1). */
  hasSteps: boolean;
  memoryLayout: number | null;
  /** Steps 4 and 6 may be called. */
  capable: boolean;
  /** `first_run_classify.py` is there as well (`reclassify`, `label_candidates`, `apply_labels`): an engine from before it answers no command of step 5. Absent = false. */
  classifyCapable?: boolean;
  /** `first_run_tidy.py` is there as well (K5': step `tidy`). Absent = false: an older engine answers `bad_arguments` to it, so it is not asked. */
  tidyCapable?: boolean;
}

export function readMemoryLayoutCapability(root: string): number | null {
  for (const relative of [path.join("agentlas_cloud", "capabilities.json"), "capabilities.json"]) {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8").replace(/^﻿/, "")) as { memory_layout?: unknown };
      let value: unknown = payload?.memory_layout;
      if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number.parseInt(value.trim(), 10);
      if (typeof value === "number" && Number.isInteger(value)) return value;
      return null;
    } catch { /* try the next place */ }
  }
  return null;
}

export function probeEngineRoot(root: string | null | undefined): EngineProbe {
  if (!root) return { hasSteps: false, memoryLayout: null, capable: false };
  let hasSteps = false;
  try { hasSteps = fs.statSync(path.join(root, "agentlas_cloud", "first_run_steps.py")).isFile(); } catch { hasSteps = false; }
  const memoryLayout = hasSteps ? readMemoryLayoutCapability(root) : null;
  const capable = hasSteps && memoryLayout !== null && memoryLayout >= REQUIRED_MEMORY_LAYOUT_CAPABILITY;
  let classifyCapable = false;
  if (capable) { try { classifyCapable = fs.statSync(path.join(root, "agentlas_cloud", "first_run_classify.py")).isFile(); } catch { classifyCapable = false; } }
  let tidyCapable = false;
  if (capable) { try { tidyCapable = fs.statSync(path.join(root, "agentlas_cloud", "first_run_tidy.py")).isFile(); } catch { tidyCapable = false; } }
  return { hasSteps, memoryLayout, capable, ...(classifyCapable ? { classifyCapable: true } : {}), ...(tidyCapable ? { tidyCapable: true } : {}) };
}

// --- step 5: the classification commands -----------------------------------------------------------------------------------

/** `reclassify` `remaining` reasons that mean "call again at once" / "stand aside a moment" (G-11 applied to 89: `budget`; `busy`, `store_locked`). Every other code ends this run's calls. */
export const RECLASSIFY_AGAIN_REASONS: ReadonlySet<string> = new Set(["budget"]);
export const RECLASSIFY_WAIT_REASONS: ReadonlySet<string> = new Set(["busy", "store_locked", "locked"]);

export interface JudgedClassify { disposition: Disposition; json: Record<string, unknown> | null; state: string; reason: string }

/** The answer of one `agentlas_cloud.first_run` classification command: the LAST LINE of standard output, parsed as JSON; no JSON is `failed/no_answer`. The exit code is never read. */
export function judgeClassify(reply: EngineReply, table: { again: ReadonlySet<string>; wait: ReadonlySet<string> } = { again: RECLASSIFY_AGAIN_REASONS, wait: RECLASSIFY_WAIT_REASONS }): JudgedClassify {
  const none = (code: string, state = "failed", reason = code): JudgedClassify => ({ disposition: { kind: "stop", code: `${state}/${reason}` }, json: null, state, reason });
  if (reply.unavailable) return none(reply.unavailable, "failed", reply.unavailable);
  if (reply.timedOut || reply.cancelled) return none("no_answer");
  const json = lastJsonLine(reply.stdout);
  if (!json) return none("no_answer");
  const state = typeof json.state === "string" ? json.state : "unknown", reason = typeof json.reason === "string" ? json.reason : "";
  const code = reason ? `${state}/${reason}` : state;
  const judged = (disposition: Disposition): JudgedClassify => ({ disposition, json, state, reason });
  if (state === "done") return judged({ kind: "done", code });
  if (state === "remaining") {
    if (table.again.has(reason)) return judged({ kind: "again", code, afterMs: AGAIN_PAUSE_MS });
    if (table.wait.has(reason)) return judged({ kind: "wait", code, afterMs: WAIT_PAUSE_MS });
  }
  return judged({ kind: "stop", code });   // failed, deferred, an unknown state, or a reason this build does not loop on
}

// --- the real runner ----------------------------------------------------------------------------------------------------------------

/** Calls `agentlas_cloud.first_run` through the desktop's one engine launcher (pinned runtime root, user environment only plus the owner binding). */
export function createEngineRunner(): EngineRunner {
  return async (call, signal) => {
    const [{ runHephaestus }, trusted] = await Promise.all([import("../hephaestus/engine"), import("../memory/trusted-owner-binding")]);
    let lease: { env: Record<string, string>; release(): void } | null = null;
    if (call.useOwnerBinding !== false) {
      try { lease = trusted.retainTrustedMemoryOwnerEnvironment(); }
      catch { return { stdout: "", stderr: "", timedOut: false, cancelled: false, unavailable: "deferred/owner_unbound" }; }
    }
    try {
      let firstStderr = "";
      const result = await runHephaestus("agentlas_cloud.first_run" as unknown as Parameters<typeof runHephaestus>[0], call.args, {
        timeoutMs: call.timeoutMs, signal, ...(lease ? { env: lease.env } : {}), ...(call.input !== undefined ? { input: call.input } : {}),
        onStderr: (line) => { if (!firstStderr) firstStderr = line; },
      });
      if (firstStderr) console.warn(`[first-run] engine stderr: ${firstStderr.slice(0, 200)}`);  // a local log line only; it can hold a path
      const text = result.error ?? "";
      return {
        stdout: result.stdout, stderr: result.stderr,
        timedOut: /타임아웃|Timed out/i.test(text), cancelled: /취소됨|Cancelled/i.test(text),
      };
    } finally { lease?.release(); }
  };
}
