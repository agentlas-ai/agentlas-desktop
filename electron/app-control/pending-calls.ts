import { createHash } from "node:crypto";

/*
 * A long app operation answers instead of timing out.
 *
 * An app operation can outlast one tool request. automations.runNow awaits the whole run, automations.create and
 * automations.planFix validate a graph, and any read waits on a Main whose event loop is busy. The caller used to give up
 * first: the daemon's device bridge closes a request at 8 s (Main's own budget is 7 s: daemon/device-bridge.ts), the
 * agentlas-turn gateway at 30 s ("Turn tool request timed out."), and what the model read was "operation-timeout ... it may
 * still be running, so read its state before repeating it" with no id to read it by (production 10-21..25: automations.runNow x2,
 * automations.planFix x2, automations.create, alive.getState, goalPanel.view, chats.getContinuitySnapshot, invoke.latestReceipt).
 * The operation itself was never cancelled; only its answer was lost.
 *
 * So a call answers within a window. Done: its result (or its typed refusal), exactly as before. Still running: a notice that
 * says so, and the same call (same operation, arguments and authority) asked again joins the operation that is running or
 * receives its finished result once. It never starts a second run: the key is the call itself, so there is no new id or tool
 * for the model to learn. A call that finished inside its window is not remembered (a deliberate repeat runs again).
 *
 * No electron import: the background service loads the notice helpers.
 */

export const APP_CALL_PENDING_VERSION = "agentlas.app-call-pending.v1";
/** How long one model-facing call waits for its operation. The daemon asks Main again until this is spent, so the worst case is this plus one
 * device-bridge deadline (8 s): under the turn gateway's 30 s and the in-process loop's 30 s MCP call timeout (local-tool-loop.ts). */
export const APP_CALL_ANSWER_WINDOW_MS = 18_000;
/** A finished result nobody asked for again is dropped after this long. */
const UNCLAIMED_KEEP_MS = 5 * 60_000;
const MAX_KEPT = 64;
/** A call still running after this long is not joined any more (a hung handler must not answer "running" for ever); the app's own rules decide a new one. */
const MAX_JOIN_AGE_MS = 30 * 60_000;

export interface AppCallPendingNotice {
  schemaVersion: typeof APP_CALL_PENDING_VERSION;
  ok: true;
  pending: true;
  status: "running";
  operation: string;
  note: string;
}

export function appCallPendingNotice(operation: string): AppCallPendingNotice {
  return { schemaVersion: APP_CALL_PENDING_VERSION, ok: true, pending: true, status: "running", operation,
    note: "Still running in the app. Repeat this same call (same operation and arguments) to get its result; it is not started a second time." };
}

export function isAppCallPending(value: unknown): value is AppCallPendingNotice {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === APP_CALL_PENDING_VERSION && (value as { pending?: unknown }).pending === true;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value) ?? "null";
}

/** The call itself: what runs, with which arguments, under which authority. Two callers with the same key mean the same effect. */
export function appCallKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update("app-call-v1\0").update(canonical(parts)).digest("hex");
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
interface Job<T> { promise: Promise<Settled<T>>; waiters: number; told: boolean; startedAt: number }

const inflight = new Map<string, Job<any>>();
const finished = new Map<string, { settled: Settled<any>; at: number }>();

function expire(now: number): void {
  for (const [key, entry] of finished) if (now - entry.at > UNCLAIMED_KEEP_MS) finished.delete(key);
  while (finished.size > MAX_KEPT) finished.delete(finished.keys().next().value as string);
}

function deliver<T>(settled: Settled<T>): T {
  if (settled.ok) return settled.value;
  throw settled.error;
}

/**
 * Run `start` for this key, or join the run already going, and answer within `windowMs`. A key whose operation finished after
 * its caller had been told "running" hands the finished outcome (a value or the same refusal) to the next identical call once.
 */
export async function answerAppCallWithin<T>(key: string, start: () => Promise<T>, windowMs: number, pending: () => T): Promise<T> {
  expire(Date.now());
  const kept = finished.get(key);
  if (kept) { finished.delete(key); return deliver(kept.settled); }
  let job = inflight.get(key) as Job<T> | undefined;
  if (job && Date.now() - job.startedAt > MAX_JOIN_AGE_MS) { inflight.delete(key); job = undefined; }
  if (!job) {
    const created: Job<T> = { waiters: 0, told: false, startedAt: Date.now(), promise: undefined as unknown as Promise<Settled<T>> };
    created.promise = Promise.resolve().then(start).then<Settled<T>, Settled<T>>(
      (value) => ({ ok: true, value }), (error) => ({ ok: false, error }),
    ).then((settled) => {
      // Registered before any caller's wait: it runs first, so a caller still waiting at this moment gets the outcome directly
      // and nothing is kept for it. Kept only for a caller that was told "running" and is no longer waiting.
      if (inflight.get(key) === created) inflight.delete(key);
      if (created.told && created.waiters === 0) { finished.set(key, { settled, at: Date.now() }); expire(Date.now()); }
      return settled;
    });
    inflight.set(key, created);
    job = created;
  }
  const current = job;
  current.waiters += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windowEnd = new Promise<"window">((resolve) => { timer = setTimeout(() => resolve("window"), windowMs); timer.unref?.(); });
  try {
    const first = await Promise.race([current.promise, windowEnd]);
    if (first === "window") { current.told = true; return pending(); }
    return deliver(first);
  } finally {
    if (timer) clearTimeout(timer);
    current.waiters -= 1;
  }
}

/** Gate-only: forget every running and kept call. */
export function resetAppCallsForTests(): void { inflight.clear(); finished.clear(); }
