#!/usr/bin/env node
// Persistent-goal loop contract gate.
//
// Asserts OUTCOMES, not implementation sentences:
//  A) The shared Python goal ledger (the state every surface joins on goal_id)
//     actually loops, stalls, budgets, completes, and reactivates — measured by
//     running the real CLI against a throwaway AGENTLAS_HOME.
//  B) The compiled desktop side keeps its cross-language contracts:
//     the cadence tokens it schedules must be parseable by the real scheduler,
//     and its hard-stop reason set must cover every stop reason the ledger was
//     MEASURED to emit in section A (drift between the two languages fails here).
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-loop-gate-"));
const env = {
  ...process.env,
  AGENTLAS_HOME: home,
  PYTHONPATH: path.join(root, "Hephaestus"),
  PYTHONUTF8: "1",
};

function ledger(args) {
  const stdout = execFileSync(
    "python3",
    ["-m", "agentlas_cloud", "workforce", "goal-ledger", ...args],
    { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout);
}

const measuredStopReasons = new Set();

// ── A1/A2: a fresh goal is immediately loopable without any model marker ──
let goal = ledger(["create", "goal:gate:loop", "--objective", "Gate objective", "--criteria", "done when verified"]);
assert.equal(goal.status, "active", "a new goal must be active");
assert.ok(goal.openTaskCount >= 1, "a new goal must never dead-end with zero open tasks before cycle 1");
let decision = ledger(["should-continue", "goal:gate:loop"]);
assert.equal(decision.continue, true, "an unmet goal must continue without any model marker");

// ── A3: no-progress stall blocks the goal and calls a human ──────────────
ledger(["create", "goal:gate:stall", "--objective", "stall detection", "--stall-window", "2"]);
let stallDecision = null;
for (let i = 0; i < 6; i += 1) {
  stallDecision = ledger(["record-cycle", "goal:gate:stall", "--progress-key", "identical"]);
  if (!stallDecision.continue) break;
}
assert.equal(stallDecision.continue, false, "identical progress keys must eventually stop the loop");
assert.equal(stallDecision.status, "blocked", "a stalled goal must be blocked (human call), not silently completed");
measuredStopReasons.add(stallDecision.reason);

// ── A3b: a stall is a pause, not a grave ─────────────────────────────────
// A goal meant to run for months will sit still for a stretch and then move
// again. These loops run when nobody is watching, so if only a human could
// clear `blocked`, the first quiet week would kill the goal for good.
const recovered = ledger(["record-cycle", "goal:gate:stall", "--progress-key", "actual-progress"]);
assert.equal(recovered.continue, true, "real progress must lift a stall — a stalled goal must not be a dead end");
assert.equal(recovered.status, "active", "progress must return a stalled goal to active");

// …and the detector must survive its own recovery, or one stall would disarm it forever.
let restall = null;
for (let i = 0; i < 6; i += 1) {
  restall = ledger(["record-cycle", "goal:gate:stall", "--progress-key", "identical-again"]);
  if (!restall.continue) break;
}
assert.equal(restall.status, "blocked", "stall detection must still fire after a recovery");

// A goal a person ended stays ended: progress after an explicit end must not revive it.
ledger(["complete", "goal:gate:stall"]);
const afterEnd = ledger(["record-cycle", "goal:gate:stall", "--progress-key", "post-mortem-progress"]);
assert.equal(afterEnd.continue, false, "progress must never revive a goal a person explicitly ended");
assert.equal(afterEnd.status, "completed");
measuredStopReasons.add(afterEnd.reason);

// ── A4: completing every task flips the decision to no-open-tasks ────────
ledger(["create", "goal:gate:tasks", "--objective", "task completion", "--task", "only work item"]);
const openTasks = ledger(["tasks", "goal:gate:tasks"]).openTasks;
assert.ok(openTasks.length >= 1, "explicit tasks must be listed as open");
for (const task of openTasks) {
  ledger(["complete-task", "goal:gate:tasks", "--task-id", task.taskId, "--evidence", "gate"]);
}
decision = ledger(["should-continue", "goal:gate:tasks"]);
assert.equal(decision.continue, false, "a goal with zero open tasks must not force continuation");
assert.equal(decision.reason, "no_open_tasks");

// ── A5: cycle budget exhaustion stops the loop ───────────────────────────
ledger(["create", "goal:gate:budget", "--objective", "budget", "--max-cycles", "2"]);
ledger(["record-cycle", "goal:gate:budget", "--progress-key", "p1"]);
decision = ledger(["record-cycle", "goal:gate:budget", "--progress-key", "p2"]);
assert.equal(decision.continue, false, "max-cycles must stop the loop");
measuredStopReasons.add(decision.reason);

// ── A6: explicit end is terminal; re-enabling reactivates a fresh campaign ─
ledger(["complete", "goal:gate:loop", "--terminal-status", "cancelled", "--reason", "gate"]);
decision = ledger(["should-continue", "goal:gate:loop"]);
assert.equal(decision.continue, false, "a cancelled goal must not continue");
measuredStopReasons.add(decision.reason);
goal = ledger(["create", "goal:gate:loop", "--objective", "Gate objective again", "--task", "resume work"]);
assert.equal(goal.status, "active", "re-enabling a terminal goal must reactivate it");
assert.equal(ledger(["should-continue", "goal:gate:loop"]).continue, true, "a reactivated goal must loop again");

// ── A7: wallclock deadline is a hard budget ──────────────────────────────
ledger(["create", "goal:gate:deadline", "--objective", "deadline", "--deadline", "2020-01-01T00:00:00Z"]);
decision = ledger(["should-continue", "goal:gate:deadline"]);
assert.equal(decision.continue, false, "an expired wallclock deadline must stop the loop");
measuredStopReasons.add(decision.reason);

// ── A8: crash durability — a separate process sees the same ledger state ─
// (fresh CLI invocations above already prove cross-process durability; this
// pins it explicitly: state must live in the store, not in process memory).
decision = ledger(["should-continue", "goal:gate:loop"]);
assert.equal(decision.continue, true, "ledger state must survive process boundaries");

// ── B: compiled desktop contracts ────────────────────────────────────────
const loopEngineering = require(path.join(root, "dist/electron/hephaestus/loop-engineering.js"));
const schedule = require(path.join(root, "dist/electron/store/schedule.js"));
const goalLedgerBridge = require(path.join(root, "dist/electron/mcp/goal-ledger.js"));

// B1: every cadence the goal loop can schedule must parse into a real future
// run in the actual scheduler, and an in-progress goal must run strictly more
// often than a stopped/backoff one.
const activeToken = loopEngineering.goalContinuationSchedule({ continue: true, reason: "open_tasks_remain" });
const backoffToken = loopEngineering.goalContinuationSchedule({ continue: false, reason: "goal_blocked" });
const specs = {};
for (const token of [activeToken, backoffToken]) {
  const spec = schedule.specFromStored(token, "UTC");
  assert.ok(spec, `cadence token ${token} must be parseable by the scheduler`);
  const next = schedule.nextRun(spec, new Date());
  assert.ok(next && Date.parse(next) > Date.now(), `cadence token ${token} must produce a future run`);
  specs[token] = spec;
}
assert.ok(
  specs[activeToken].everyMs < specs[backoffToken].everyMs,
  "an in-progress goal must be scheduled more frequently than a halted one",
);

// B2: the TS hard-stop set must cover every stop reason the ledger actually
// emitted above. A reason emitted by Python but unknown to TS would let a
// budget-exhausted goal keep running on the model marker alone.
for (const reason of measuredStopReasons) {
  assert.ok(
    goalLedgerBridge.GOAL_HARD_STOP_REASONS.has(reason),
    `measured ledger stop reason ${reason} must be a desktop hard-stop`,
  );
}

// B3: the progress fingerprint contract — identical visible output means no
// progress; different output means progress; incidental trailing whitespace
// must not fake progress.
const keyA = goalLedgerBridge.goalProgressKeyForText("result body");
assert.equal(keyA, goalLedgerBridge.goalProgressKeyForText("result body"), "progress key must be deterministic");
assert.equal(keyA, goalLedgerBridge.goalProgressKeyForText("result body\n"), "trailing whitespace must not fake progress");
assert.notEqual(keyA, goalLedgerBridge.goalProgressKeyForText("different result"), "different output must count as progress");

fs.rmSync(home, { recursive: true, force: true });
console.log("goal-loop contract gate: PASS");
console.log(`  measured ledger stop reasons covered by desktop hard-stops: ${[...measuredStopReasons].join(", ")}`);
