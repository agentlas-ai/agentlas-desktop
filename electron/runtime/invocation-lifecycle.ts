import { assertInvocationChatAvailable } from "./run-id";

/**
 * Production invocation state boundary.
 *
 * renderer busy/cancelPending  = a projection only (never execution authority)
 * this registry               = live main/host-process authority
 * run_events                  = durable receipt/retry authority
 * chat_runtime_sessions       = provider resume context only
 * invocation receipt folder  = result-discovery authority
 *
 * A cancelled run intentionally stays registered until its runtime promise
 * settles. Removing it when AbortController.abort() is called would let a
 * retry start while the old CLI/MCP process tree is still shutting down.
 */
export interface InvocationLifecycleRecord {
  controller: AbortController;
  chatId: string;
  cancelRequestedAt: string | null;
}

export type InvocationCancelResult = "requested" | "already-requested" | "not-found";

export class InvocationLifecycleRegistry<T extends InvocationLifecycleRecord> {
  private readonly active = new Map<string, T>();
  private readonly settled = new Set<string>();
  private readonly maxSettledIds: number;

  constructor(maxSettledIds = 2_000) {
    this.maxSettledIds = Math.max(16, maxSettledIds);
  }

  has(runId: string): boolean {
    return this.active.has(runId);
  }

  hasSeen(runId: string): boolean {
    return this.active.has(runId) || this.settled.has(runId);
  }

  get(runId: string): T | undefined {
    return this.active.get(runId);
  }

  values(): IterableIterator<T> {
    return this.active.values();
  }

  entries(): IterableIterator<[string, T]> {
    return this.active.entries();
  }

  register(runId: string, record: T): void {
    if (this.hasSeen(runId)) throw new Error("Invocation runId has already been used");
    assertInvocationChatAvailable(record.chatId, this.active.values());
    this.active.set(runId, record);
  }

  /**
   * Undo only a pre-host registration whose durable start write failed.
   * Unlike settle(), this deliberately does not consume the run id because no
   * host work was allowed to start and no durable idempotency receipt exists.
   */
  rollbackRegistration(runId: string): boolean {
    return this.active.delete(runId);
  }

  requestCancel(runId: string, at = new Date().toISOString()): InvocationCancelResult {
    const record = this.active.get(runId);
    if (!record) return "not-found";
    if (record.cancelRequestedAt || record.controller.signal.aborted) return "already-requested";
    record.cancelRequestedAt = at;
    record.controller.abort();
    return "requested";
  }

  /** Call only after the runtime promise/terminal event proves host settlement. */
  settle(runId: string): boolean {
    const deleted = this.active.delete(runId);
    if (!deleted) return false;
    this.settled.add(runId);
    if (this.settled.size > this.maxSettledIds) {
      const oldest = this.settled.values().next().value as string | undefined;
      if (oldest) this.settled.delete(oldest);
    }
    return true;
  }

  activeChatIds(): string[] {
    return [...new Set([...this.active.values()].map((record) => record.chatId))];
  }
}

/**
 * Atomic start boundary for the main process: a run is not publishable and its
 * host adapter must not be called until the durable idempotency row succeeds.
 */
export function registerDurableInvocationStart<T extends InvocationLifecycleRecord>(input: {
  registry: InvocationLifecycleRegistry<T>;
  runId: string;
  record: T;
  persistStart: () => void;
  publishActiveState: () => void;
}): void {
  input.registry.register(input.runId, input.record);
  try {
    input.persistStart();
  } catch (error) {
    input.registry.rollbackRegistration(input.runId);
    input.publishActiveState();
    throw error;
  }
  input.publishActiveState();
}
