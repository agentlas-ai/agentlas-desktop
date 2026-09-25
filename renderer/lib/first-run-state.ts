/*
 * Desktop first-run onboarding state (screens 02–08, 2026-09-25 redesign).
 *
 * Why a new key and not the Work tour's `agentlas.work.firstRunOnboarding.v3`:
 *   the v3 key means "saw the old Work tour". This flow is a different product
 *   contract (name → Chrome → AI → prefs → mailbox → One), so it gets its own
 *   versioned record. The two never overwrite each other.
 *
 * Scope: one record per signed-in account (opaque `accountFingerprint`), so a
 * second account on the same machine never inherits someone else's progress.
 *
 * Resume rule (PLAN): after a close or crash, reopen at the step after the last
 * COMPLETED one. A step is completed only when its own effect was saved and
 * re-read (name saved, prefs saved) or when the person explicitly skipped it.
 * Uncertain external effects (checkout, CLI login) are never recorded as done.
 *
 * Existing users (decided conservatively): the flow opens automatically only on
 * a fresh install. Anyone with prior Desktop use is recorded as `existing` and
 * can open the flow from Settings instead.
 */

export const FIRST_RUN_SCHEMA = 1 as const;
const KEY_PREFIX = "agentlas.desktop.firstRun.v1";
/** Same-window request to open the flow (Settings → "Run first-time setup again"). */
export const FIRST_RUN_OPEN_EVENT = "agentlas:first-run-open";

export const FIRST_RUN_STEPS = ["name", "browser", "ai", "preferences", "mailbox"] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export type FirstRunOutcome = "done" | "skipped";

export interface FirstRunRecord {
  schema: typeof FIRST_RUN_SCHEMA;
  /** new = fresh install (auto-open); existing = prior use (opens only on request). */
  audience: "new" | "existing";
  /** Per-step completion receipts. Missing = not completed. */
  steps: Partial<Record<FirstRunStep, { outcome: FirstRunOutcome; at: string }>>;
  /** Set once the person reached One from the last step. */
  completedAt: string | null;
  updatedAt: string;
}

export function firstRunStorageKey(accountFingerprint: string | undefined): string {
  const scope = accountFingerprint && /^[A-Za-z0-9_-]{4,128}$/.test(accountFingerprint) ? accountFingerprint : "anonymous";
  return `${KEY_PREFIX}:${scope}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parse strictly; anything malformed is treated as absent (never as "completed"). */
export function parseFirstRunRecord(raw: string | null): FirstRunRecord | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || value.schema !== FIRST_RUN_SCHEMA) return null;
  if (value.audience !== "new" && value.audience !== "existing") return null;
  if (!isRecord(value.steps)) return null;
  const steps: FirstRunRecord["steps"] = {};
  for (const step of FIRST_RUN_STEPS) {
    const entry = value.steps[step];
    if (!isRecord(entry)) continue;
    if ((entry.outcome === "done" || entry.outcome === "skipped") && typeof entry.at === "string") {
      steps[step] = { outcome: entry.outcome, at: entry.at };
    }
  }
  return {
    schema: FIRST_RUN_SCHEMA,
    audience: value.audience,
    steps,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function newFirstRunRecord(audience: FirstRunRecord["audience"], now = new Date()): FirstRunRecord {
  return { schema: FIRST_RUN_SCHEMA, audience, steps: {}, completedAt: null, updatedAt: now.toISOString() };
}

export function recordStep(record: FirstRunRecord, step: FirstRunStep, outcome: FirstRunOutcome, now = new Date()): FirstRunRecord {
  return { ...record, steps: { ...record.steps, [step]: { outcome, at: now.toISOString() } }, updatedAt: now.toISOString() };
}

export function recordCompleted(record: FirstRunRecord, now = new Date()): FirstRunRecord {
  return { ...record, completedAt: now.toISOString(), updatedAt: now.toISOString() };
}

/**
 * Where to reopen: the first step, in flow order, that has no completion receipt.
 * Returns null when every step is settled.
 */
export function resumeStep(record: FirstRunRecord): FirstRunStep | null {
  for (const step of FIRST_RUN_STEPS) {
    if (!record.steps[step]) return step;
  }
  return null;
}

/** Should the flow open by itself on this launch? */
export function shouldAutoOpen(record: FirstRunRecord | null): boolean {
  return Boolean(record && record.audience === "new" && !record.completedAt);
}

/**
 * Prior-use evidence, measured (not guessed) from this machine's data. Any one
 * signal classifies the account as `existing` — the conservative direction,
 * because re-showing setup to someone mid-work is the costlier mistake.
 */
export interface PriorUseSignals {
  legacyWorkTourSeen: boolean;
  profileCustomized: boolean;
  profileAgeMs: number | null;
  chatCount: number | null;
  projectCount: number | null;
}

const FRESH_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function classifyAudience(signals: PriorUseSignals): FirstRunRecord["audience"] {
  if (signals.legacyWorkTourSeen || signals.profileCustomized) return "existing";
  if ((signals.chatCount ?? 0) > 0 || (signals.projectCount ?? 0) > 0) return "existing";
  // Unknown counts cannot prove a fresh install: stay conservative.
  if (signals.chatCount === null || signals.projectCount === null) return "existing";
  if (signals.profileAgeMs === null || signals.profileAgeMs > FRESH_PROFILE_MAX_AGE_MS) return "existing";
  return "new";
}

export function readFirstRunRecord(storage: Pick<Storage, "getItem">, accountFingerprint: string | undefined): FirstRunRecord | null {
  try { return parseFirstRunRecord(storage.getItem(firstRunStorageKey(accountFingerprint))); } catch { return null; }
}

export function writeFirstRunRecord(storage: Pick<Storage, "setItem">, accountFingerprint: string | undefined, record: FirstRunRecord): boolean {
  try {
    storage.setItem(firstRunStorageKey(accountFingerprint), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
