// The cleanup's state as a screen reads it (Agentlas 2.0 redesign backend C): one cheap read, no write, no timer, no new store. The screen asks when it opens and once more for each `firstRun:changed` signal Main sends
// (gate.ts `emitFirstRunStateChange`: an open code, the step or the end changed; no timer).
//
// Light on purpose (like `start-guard.ts`): it imports the gate only, never the conductor. The two markers it reads are the conductor's own, named in first-run.ts
// (`NOTICE_KEY_PREFIX` = the end notice, written per account; `OPEN_WORK_KEY` = "a step after the notice is still owed"); the same two start-guard.ts reads.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FirstRunStatus } from "../../shared/first-run-status";
import { FIRST_RUN_COUNTS_KEY_PREFIX, firstRunFinalCodes, firstRunMigrationEnabled, firstRunOpenCodes, firstRunStep } from "./gate";

const NOTICE_KEY_PREFIX = "first-run-notice:v2:";   // first-run.ts NOTICE_KEY_PREFIX
const OPEN_WORK_KEY = "first-run-open:v1";          // first-run.ts OPEN_WORK_KEY

/** The conductor's per-account key (first-run.ts `accountIdentity`): the first 16 hex characters of the sha256 of the memory owner namespace. */
export function firstRunAccountKey(ownerNamespace: string): string {
  return createHash("sha256").update(ownerNamespace, "utf8").digest("hex").slice(0, 16);
}

/** The totals row the conductor keeps (first-run.ts `persistCounts`): only the keys that are whole numbers of 0 or more are given; anything else in the row is not read. Never throws. */
function readCounts(db: Pick<Database.Database, "prepare">, ownerNamespace: string): NonNullable<FirstRunStatus["counts"]> | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(FIRST_RUN_COUNTS_KEY_PREFIX + firstRunAccountKey(ownerNamespace)) as { value?: unknown } | undefined;
    if (!row || typeof row.value !== "string") return null;
    const parsed = JSON.parse(row.value) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const out: NonNullable<FirstRunStatus["counts"]> = {};
    for (const key of ["agents", "memory", "removed"] as const) { const v = parsed[key]; if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[key] = v; }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export function readFirstRunStatus(input: { db: Pick<Database.Database, "prepare">; ownerNamespace: string | null }): FirstRunStatus {
  if (!firstRunMigrationEnabled()) return { applicable: false, done: false, openCodes: [] };
  const openCodes = firstRunOpenCodes();
  let done = false;
  try {
    if (input.ownerNamespace) {
      const marker = input.db.prepare("SELECT 1 FROM meta WHERE key = ?").get(NOTICE_KEY_PREFIX + firstRunAccountKey(input.ownerNamespace));
      const owed = input.db.prepare("SELECT 1 FROM meta WHERE key = ?").get(OPEN_WORK_KEY);
      done = marker !== undefined && owed === undefined;
    }
  } catch { done = false; }   // a store that cannot be read is "not finished", never "finished"
  const finals = firstRunFinalCodes();   // only when there is one: an answer with none keeps the shape it had
  // The step only while it runs, the totals only when it is over: a number in between would read as a result (or as progress of work that is not running).
  const step = done ? null : firstRunStep();
  const counts = done && input.ownerNamespace ? readCounts(input.db, input.ownerNamespace) : null;
  return { applicable: true, done, openCodes, ...(finals.length ? { finalCodes: finals } : {}), ...(step ? { step } : {}), ...(counts ? { counts } : {}) };
}
